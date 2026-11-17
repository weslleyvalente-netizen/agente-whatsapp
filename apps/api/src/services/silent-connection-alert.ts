import { getAdminClient, getAllOrganizations, getInstancesByOrganization, listManagerUserIds, sendPushToUser } from "@aula-agente/database";
import { DEFAULT_SILENCE_THRESHOLDS, decideAlertAction, evaluateSilentConnection, type SilenceEvaluation } from "@aula-agente/shared";

// Alerta de "conexão muda": a Evolution diz 'open', mas nenhuma mensagem de cliente chega. Roda no processo da API (setInterval),
// só para organizações com settings.silent_connection_alert_enabled === true (desligado por padrão). Usa a observação do monitor
// (evolution_connection_observations: estado e última recebida na Evolution) + a última mensagem de cliente no CRM + o volume
// habitual da MESMA hora da semana nas últimas 4 semanas. Avisa gestores por PUSH (canal independente do WhatsApp afetado).
// Um alerta aberto por instância (tabela silent_connection_alerts), repetição no máximo a cada 60 min, resolve sozinho quando volta.
// NÃO envia mensagem de WhatsApp (verificação ativa com mensagem externa controlada fica para outra etapa, com autorização).

export const SILENT_CYCLE_MS = 5 * 60 * 1000;
export const MAX_OBSERVATION_AGE_MS = 15 * 60 * 1000;
export const BASELINE_WEEKS = 4;
export const REPEAT_MINUTES = 60;

interface Log { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void }
export interface OpenAlert { id: string; openedAt: Date; lastNotifiedAt: Date }
export interface Observation { state: string | null; lastEvolutionAt: Date | null; observedAt: Date }

export interface SilentDeps {
  listOrganizations(): Promise<Array<{ id: string; settings: { silent_connection_alert_enabled?: boolean } }>>;
  listInstances(organizationId: string): Promise<Array<{ id: string; instance_name: string }>>;
  latestObservation(organizationId: string, instanceName: string): Promise<Observation | null>;
  lastCrmInboundAt(organizationId: string, instanceId: string): Promise<Date | null>;
  baselinePerHour(organizationId: string, instanceId: string, now: Date): Promise<number | null>;
  getOpenAlert(organizationId: string, instanceName: string): Promise<OpenAlert | null>;
  openAlert(organizationId: string, instanceName: string, now: Date, evidence: Record<string, unknown>): Promise<void>;
  touchAlert(id: string, now: Date, evidence: Record<string, unknown>): Promise<void>;
  resolveAlert(id: string, now: Date): Promise<void>;
  notifyManagers(organizationId: string, payload: { title: string; body: string; url: string; tag: string }): Promise<number>;
  log: Log;
}

const latest = (...ds: Array<Date | null | undefined>) => ds.filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

export function buildEvidence(ev: SilenceEvaluation, extra: { lastInboundAt: Date | null; lastCrmAt: Date | null; lastEvolutionAt: Date | null; state: string | null; baselinePerHour: number | null }) {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    evolution_state: extra.state, last_inbound_at: iso(extra.lastInboundAt), last_crm_inbound_at: iso(extra.lastCrmAt), last_evolution_inbound_at: iso(extra.lastEvolutionAt),
    silent_minutes: ev.silentMinutes === null ? null : Math.round(ev.silentMinutes), baseline_per_hour: extra.baselinePerHour,
    expected_in_silence: ev.expectedInSilence === null ? null : Math.round(ev.expectedInSilence * 10) / 10, probability_of_silence: ev.probabilityOfSilence, reason: ev.reason,
  };
}

export async function runSilentConnectionCycle(deps: SilentDeps, now: Date = new Date()): Promise<void> {
  let orgs: Awaited<ReturnType<SilentDeps["listOrganizations"]>>;
  try { orgs = await deps.listOrganizations(); } catch (err) { deps.log.error({ errName: (err as Error)?.name }, "silent-connection: failed to list organizations"); return; }
  for (const org of orgs) {
    if (org.settings?.silent_connection_alert_enabled !== true) continue;
    let instances: Array<{ id: string; instance_name: string }>;
    try { instances = await deps.listInstances(org.id); } catch (err) { deps.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "silent-connection: failed to list instances"); continue; }
    for (const inst of instances) {
      try {
        const obs = await deps.latestObservation(org.id, inst.instance_name);
        // Sem observação recente do monitor não dá para afirmar o estado da Evolution: não avalia (e não inventa alerta).
        if (!obs || now.getTime() - obs.observedAt.getTime() > MAX_OBSERVATION_AGE_MS) {
          deps.log.info({ organizationId: org.id, instanceName: inst.instance_name }, "silent-connection: observação do monitor ausente/desatualizada; ciclo ignorado");
          continue;
        }
        const crmAt = await deps.lastCrmInboundAt(org.id, inst.id);
        const lastInbound = latest(crmAt, obs.lastEvolutionAt);
        const baseline = await deps.baselinePerHour(org.id, inst.id, now);
        const ev = evaluateSilentConnection({ now, evolutionState: obs.state, lastInboundAt: lastInbound, baselinePerHour: baseline }, DEFAULT_SILENCE_THRESHOLDS);
        const open = await deps.getOpenAlert(org.id, inst.instance_name);
        const action = decideAlertAction(open ? { openedAt: open.openedAt, lastNotifiedAt: open.lastNotifiedAt } : null, ev, now, REPEAT_MINUTES);
        if (action === "none") continue;
        const evidence = buildEvidence(ev, { lastInboundAt: lastInbound, lastCrmAt: crmAt, lastEvolutionAt: obs.lastEvolutionAt, state: obs.state, baselinePerHour: baseline });
        if (action === "resolve") { await deps.resolveAlert(open!.id, now); deps.log.info({ organizationId: org.id, instanceName: inst.instance_name }, "silent-connection: alerta resolvido (voltou a receber)"); continue; }
        // Grava primeiro (evidência e anti-repetição), notifica depois: falha no push nunca apaga a evidência nem causa reenvio em loop.
        if (action === "open") await deps.openAlert(org.id, inst.instance_name, now, evidence); else await deps.touchAlert(open!.id, now, evidence);
        const mins = evidence.silent_minutes ?? 0;
        try {
          const sent = await deps.notifyManagers(org.id, {
            title: "WhatsApp pode estar mudo",
            body: `A conexão aparece ativa, mas nenhuma mensagem de cliente chega há ${mins} min (habitual: ~${Math.round(baseline ?? 0)}/h). Confira o celular da loja e o CRM.`,
            url: "/", tag: `silent-connection-${inst.instance_name}`,
          });
          deps.log.info({ organizationId: org.id, instanceName: inst.instance_name, action, silentMinutes: mins, pushSent: sent }, "silent-connection: alerta de conexão muda");
        } catch (err) { deps.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "silent-connection: falha ao notificar (alerta gravado)"); }
      } catch (err) { deps.log.error({ organizationId: org.id, instanceName: inst.instance_name, errName: (err as Error)?.name }, "silent-connection: avaliação falhou"); }
    }
  }
}

export const defaultSilentDeps = (log: Log): SilentDeps => ({
  async listOrganizations() { return (await getAllOrganizations(getAdminClient())) as Array<{ id: string; settings: { silent_connection_alert_enabled?: boolean } }>; },
  async listInstances(organizationId) { return (await getInstancesByOrganization(getAdminClient(), organizationId)) as Array<{ id: string; instance_name: string }>; },
  async latestObservation(organizationId, instanceName) {
    const { data, error } = await getAdminClient().from("evolution_connection_observations").select("observed_at, evolution_state, query_ok, last_evolution_message_at")
      .eq("organization_id", organizationId).eq("instance_name", instanceName).order("observed_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as { observed_at: string; evolution_state: string | null; query_ok: boolean; last_evolution_message_at: string | null };
    return { state: r.query_ok ? r.evolution_state : null, lastEvolutionAt: r.last_evolution_message_at ? new Date(r.last_evolution_message_at) : null, observedAt: new Date(r.observed_at) };
  },
  async lastCrmInboundAt(organizationId, instanceId) {
    const { data, error } = await getAdminClient().from("messages").select("created_at, conversations!inner(evolution_instance_id)")
      .eq("organization_id", organizationId).eq("role", "contact").eq("conversations.evolution_instance_id", instanceId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? new Date((data as { created_at: string }).created_at) : null;
  },
  // Volume habitual: mediana das contagens de mensagens de cliente na mesma hora da semana (BRT) nas últimas semanas.
  async baselinePerHour(organizationId, instanceId, now) {
    const hourMs = 3600_000;
    const startOfHour = Math.floor((now.getTime() - 3 * hourMs) / hourMs) * hourMs + 3 * hourMs; // início da hora corrente (alinhado a BRT)
    const counts: number[] = [];
    for (let w = 1; w <= BASELINE_WEEKS; w++) {
      const from = new Date(startOfHour - w * 7 * 24 * hourMs), to = new Date(from.getTime() + hourMs);
      const { count, error } = await getAdminClient().from("messages").select("id, conversations!inner(evolution_instance_id)", { count: "exact", head: true })
        .eq("organization_id", organizationId).eq("role", "contact").eq("conversations.evolution_instance_id", instanceId)
        .gte("created_at", from.toISOString()).lt("created_at", to.toISOString());
      if (error) throw error;
      counts.push(count ?? 0);
    }
    counts.sort((a, b) => a - b);
    return (counts[1] + counts[2]) / 2;
  },
  async getOpenAlert(organizationId, instanceName) {
    const { data, error } = await getAdminClient().from("silent_connection_alerts").select("id, opened_at, last_notified_at")
      .eq("organization_id", organizationId).eq("instance_name", instanceName).is("resolved_at", null).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as { id: string; opened_at: string; last_notified_at: string };
    return { id: r.id, openedAt: new Date(r.opened_at), lastNotifiedAt: new Date(r.last_notified_at) };
  },
  async openAlert(organizationId, instanceName, now, evidence) {
    const { error } = await getAdminClient().from("silent_connection_alerts").insert({ organization_id: organizationId, instance_name: instanceName, opened_at: now.toISOString(), last_notified_at: now.toISOString(), evidence });
    if (error && (error as { code?: string }).code !== "23505") throw error; // 23505: outro processo abriu o mesmo alerta ao mesmo tempo
  },
  async touchAlert(id, now, evidence) {
    const { data: cur } = await getAdminClient().from("silent_connection_alerts").select("notify_count").eq("id", id).maybeSingle();
    const { error } = await getAdminClient().from("silent_connection_alerts").update({ last_notified_at: now.toISOString(), notify_count: ((cur as { notify_count?: number } | null)?.notify_count ?? 1) + 1, evidence }).eq("id", id);
    if (error) throw error;
  },
  async resolveAlert(id, now) {
    const { error } = await getAdminClient().from("silent_connection_alerts").update({ resolved_at: now.toISOString() }).eq("id", id);
    if (error) throw error;
  },
  async notifyManagers(organizationId, payload) {
    const db = getAdminClient();
    let sent = 0;
    for (const userId of await listManagerUserIds(db, organizationId)) {
      try { sent += (await sendPushToUser(db, userId, payload, { organizationId })).sent; } catch { /* um gestor sem assinatura válida não impede os demais */ }
    }
    return sent;
  },
  log,
});

/** SILENT_CONNECTION_ALERT_DISABLED=1 no ambiente da API impede até a criação do timer. */
export function startSilentConnectionAlert(log: Log = console): NodeJS.Timeout | null {
  if (process.env.SILENT_CONNECTION_ALERT_DISABLED === "1") return null;
  const deps = defaultSilentDeps(log);
  let busy = false;
  const tick = () => { if (busy) return; busy = true; runSilentConnectionCycle(deps).catch((err) => log.error({ errName: (err as Error)?.name }, "silent-connection: tick failed")).finally(() => { busy = false; }); };
  setTimeout(tick, 120_000).unref(); // depois da primeira observação do monitor (90 s)
  const timer = setInterval(tick, SILENT_CYCLE_MS);
  timer.unref();
  return timer;
}
