import { getAdminClient, getAllOrganizations, getInstancesByOrganization, isPushConfigured, listManagerUserIds, hasPushSubscription, sendPushToUser } from "@aula-agente/database";
import {
  DEFAULT_SILENCE_THRESHOLDS, decideAlertAction, evaluateMonitorHealth, evaluateSilentConnection, resolveSilentAlertMode,
  type SilenceEvaluation, type SilentAlertMode,
} from "@aula-agente/shared";

// Alerta de "conexão muda": a Evolution diz 'open', mas nenhuma mensagem de cliente chega. Roda no processo da API (setInterval).
// Modo por organização (settings.silent_connection_alert_mode): off (padrão) | shadow (só REGISTRA o que enviaria, sem notificar) | on.
// "on" só notifica de verdade se houver canal comprovado (VAPID configurado e ao menos um gestor com push); sem isso roda como
// shadow e registra a condição `push_not_ready`. Três condições distintas, cada uma com no máximo um alerta aberto por instância:
//   silent_connection  Evolution 'open' sem receber além do habitual para a hora da semana;
//   monitor_blind      o monitor não tem observação recente/válida (não dá para afirmar nada);
//   push_not_ready     modo on pedido, mas sem gestor com push funcional.
// Notificação sem duplicar em execuções concorrentes: quem notifica é quem VENCE uma gravação atômica (insert com índice único
// parcial / update condicional); falha no push nunca apaga a evidência. Sem mensagem de WhatsApp (verificação ativa é outra etapa).
// Opcional: SILENT_CONNECTION_HEARTBEAT_URL recebe um GET a cada ciclo saudável (monitor externo "dead-man's switch": se os pings
// param, o serviço externo avisa que o PRÓPRIO monitoramento morreu). O ping não leva dados.

export const SILENT_CYCLE_MS = 5 * 60 * 1000;
export const MAX_OBSERVATION_AGE_MS = 15 * 60 * 1000;
export const BASELINE_WEEKS = 4;
export const REPEAT_MINUTES = 60;

export type AlertKind = "silent_connection" | "monitor_blind" | "push_not_ready";
interface Log { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void }
export interface OpenAlert { id: string; openedAt: Date; lastNotifiedAt: Date }
export interface Observation { state: string | null; queryOk: boolean; lastEvolutionAt: Date | null; observedAt: Date }
export interface PushReadiness { vapidConfigured: boolean; managers: number; managersWithPush: number }
export const isPushReady = (r: PushReadiness) => r.vapidConfigured && r.managersWithPush > 0;

export interface SilentDeps {
  listOrganizations(): Promise<Array<{ id: string; settings: { silent_connection_alert_mode?: unknown } }>>;
  listInstances(organizationId: string): Promise<Array<{ id: string; instance_name: string }>>;
  latestObservation(organizationId: string, instanceName: string): Promise<Observation | null>;
  lastCrmInboundAt(organizationId: string, instanceId: string): Promise<Date | null>;
  baselinePerHour(organizationId: string, instanceId: string, now: Date): Promise<number | null>;
  pushReadiness(organizationId: string): Promise<PushReadiness>;
  getOpenAlert(organizationId: string, instanceName: string, kind: AlertKind, mode: SilentAlertMode): Promise<OpenAlert | null>;
  /** true = ESTE processo abriu o alerta; false = outro processo abriu ao mesmo tempo (índice único): não notifica. */
  openAlert(organizationId: string, instanceName: string, kind: AlertKind, mode: SilentAlertMode, now: Date, evidence: Record<string, unknown>): Promise<boolean>;
  /** Atômico: só devolve true para UM processo se last_notified_at ainda for anterior ao limite. */
  claimRepeat(id: string, now: Date, repeatMinutes: number, evidence: Record<string, unknown>): Promise<boolean>;
  resolveAlert(id: string, now: Date): Promise<void>;
  notifyManagers(organizationId: string, payload: { title: string; body: string; url: string; tag: string }): Promise<number>;
  /** Monitor externo (opcional): chamado ao fim de um ciclo saudável. */
  heartbeat?(): Promise<void>;
  log: Log;
}

const latest = (...ds: Array<Date | null | undefined>) => ds.filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function buildEvidence(ev: SilenceEvaluation, extra: { lastInboundAt: Date | null; lastCrmAt: Date | null; lastEvolutionAt: Date | null; state: string | null; baselinePerHour: number | null }) {
  return {
    evolution_state: extra.state, last_inbound_at: iso(extra.lastInboundAt), last_crm_inbound_at: iso(extra.lastCrmAt), last_evolution_inbound_at: iso(extra.lastEvolutionAt),
    silent_minutes: ev.silentMinutes === null ? null : Math.round(ev.silentMinutes), baseline_per_hour: extra.baselinePerHour,
    expected_in_silence: ev.expectedInSilence === null ? null : Math.round(ev.expectedInSilence * 10) / 10, probability_of_silence: ev.probabilityOfSilence, reason: ev.reason,
  };
}

const MESSAGES: Record<AlertKind, (e: Record<string, unknown>) => { title: string; body: string }> = {
  silent_connection: (e) => ({ title: "WhatsApp pode estar mudo", body: `A conexão aparece ativa, mas nenhuma mensagem de cliente chega há ${e.silent_minutes ?? "?"} min (habitual: ~${Math.round(Number(e.baseline_per_hour ?? 0))}/h). Confira o celular da loja e o CRM.` }),
  monitor_blind: (e) => ({ title: "Monitoramento do WhatsApp sem dados", body: `O monitor da conexão não consegue confirmar o estado (${e.reason ?? "sem observação"}${e.age_minutes != null ? `, há ${e.age_minutes} min` : ""}). Verifique a API e a Evolution.` }),
  push_not_ready: () => ({ title: "Alerta de conexão muda sem canal de aviso", body: "O modo 'on' foi pedido, mas nenhum gestor tem push ativo. O alerta roda só em modo sombra." }),
};

interface ApplyCtx { deps: SilentDeps; organizationId: string; instanceName: string; kind: AlertKind; effective: SilentAlertMode; now: Date }

/** Aplica open/repeat/resolve de UMA condição. Grava primeiro (evidência + anti-duplicação), notifica só quem venceu a gravação. */
async function applyCondition(c: ApplyCtx, open: OpenAlert | null, action: "open" | "repeat" | "resolve" | "none", evidence: Record<string, unknown>): Promise<void> {
  const { deps, organizationId, instanceName, kind, effective, now } = c;
  if (action === "none") return;
  if (action === "resolve") { await deps.resolveAlert(open!.id, now); deps.log.info({ organizationId, instanceName, kind, mode: effective }, "silent-connection: condição resolvida"); return; }
  const won = action === "open"
    ? await deps.openAlert(organizationId, instanceName, kind, effective, now, evidence)
    : await deps.claimRepeat(open!.id, now, REPEAT_MINUTES, evidence);
  if (!won) { deps.log.info({ organizationId, instanceName, kind, action }, "silent-connection: outro processo já tratou esta condição (sem notificar de novo)"); return; }
  if (effective === "shadow" || kind === "push_not_ready") {
    deps.log.info({ organizationId, instanceName, kind, action, mode: "shadow", evidence }, "silent-connection: [SOMBRA] enviaria aviso aos gestores");
    return;
  }
  try {
    const m = MESSAGES[kind](evidence);
    const sent = await deps.notifyManagers(organizationId, { ...m, url: "/", tag: `silent-connection-${kind}-${instanceName}` });
    deps.log.info({ organizationId, instanceName, kind, action, pushSent: sent }, "silent-connection: aviso enviado");
  } catch (err) { deps.log.error({ organizationId, instanceName, kind, errName: (err as Error)?.name }, "silent-connection: falha ao notificar (alerta gravado)"); }
}

/** `isCurrent`: um ciclo que já foi ultrapassado por outro (ficou lento e o laço iniciou um novo) NÃO pode mais emitir heartbeat ao terminar. */
export async function runSilentConnectionCycle(deps: SilentDeps, now: Date = new Date(), isCurrent: () => boolean = () => true): Promise<void> {
  let orgs: Awaited<ReturnType<SilentDeps["listOrganizations"]>>;
  try { orgs = await deps.listOrganizations(); } catch (err) { deps.log.error({ errName: (err as Error)?.name }, "silent-connection: failed to list organizations"); return; }
  let anyEnabled = false; let failures = 0; // falha em qualquer etapa = ciclo NÃO saudável = sem ping (o monitor externo percebe)
  for (const org of orgs) {
    const requested = resolveSilentAlertMode(org.settings);
    if (requested === "off") continue;
    anyEnabled = true;
    // "on" só vale com canal comprovado; senão cai para sombra e registra a condição (não finge que avisa).
    let effective: SilentAlertMode = requested;
    if (requested === "on") {
      let ready = false;
      try { ready = isPushReady(await deps.pushReadiness(org.id)); } catch (err) { failures++; deps.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "silent-connection: falha ao verificar o canal de push"); }
      try {
        const open = await deps.getOpenAlert(org.id, "*", "push_not_ready", "shadow");
        const action = decideAlertAction(open ? { openedAt: open.openedAt, lastNotifiedAt: open.lastNotifiedAt } : null, { status: ready ? "ok" : "silent", silentMinutes: null, expectedInSilence: null, probabilityOfSilence: null, reason: ready ? "ok" : "no_manager_push" }, now, REPEAT_MINUTES);
        await applyCondition({ deps, organizationId: org.id, instanceName: "*", kind: "push_not_ready", effective: "shadow", now }, open, action, { requested_mode: "on", reason: "no_manager_with_push_or_vapid_missing" });
      } catch (err) { failures++; deps.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "silent-connection: falha ao registrar push_not_ready"); }
      if (!ready) effective = "shadow";
    }
    let instances: Array<{ id: string; instance_name: string }>;
    try { instances = await deps.listInstances(org.id); } catch (err) { failures++; deps.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "silent-connection: failed to list instances"); continue; }
    for (const inst of instances) {
      const base = { deps, organizationId: org.id, instanceName: inst.instance_name, effective, now };
      try {
        const obs = await deps.latestObservation(org.id, inst.instance_name);
        // 1) Saúde do próprio monitor: cego = condição própria (não avalia "mudo" nem "tudo bem").
        const health = evaluateMonitorHealth({ now, observation: obs ? { observedAt: obs.observedAt, queryOk: obs.queryOk } : null, maxAgeMs: MAX_OBSERVATION_AGE_MS });
        const blindOpen = await deps.getOpenAlert(org.id, inst.instance_name, "monitor_blind", effective);
        const blindEv = health.status === "blind" ? { reason: health.reason, age_minutes: health.ageMinutes } : {};
        const blindAction = decideAlertAction(blindOpen ? { openedAt: blindOpen.openedAt, lastNotifiedAt: blindOpen.lastNotifiedAt } : null,
          { status: health.status === "blind" ? "silent" : "ok", silentMinutes: null, expectedInSilence: null, probabilityOfSilence: null, reason: health.status }, now, REPEAT_MINUTES);
        await applyCondition({ ...base, kind: "monitor_blind" }, blindOpen, blindAction, blindEv);
        if (health.status === "blind" || !obs) { deps.log.info({ organizationId: org.id, instanceName: inst.instance_name, reason: health.status === "blind" ? health.reason : "no_observation" }, "silent-connection: monitor sem dados válidos; avaliação de mudez ignorada"); continue; }

        // 2) Conexão muda.
        const crmAt = await deps.lastCrmInboundAt(org.id, inst.id);
        const lastInbound = latest(crmAt, obs.lastEvolutionAt);
        const baseline = await deps.baselinePerHour(org.id, inst.id, now);
        const ev = evaluateSilentConnection({ now, evolutionState: obs.state, lastInboundAt: lastInbound, baselinePerHour: baseline }, DEFAULT_SILENCE_THRESHOLDS);
        const open = await deps.getOpenAlert(org.id, inst.instance_name, "silent_connection", effective);
        const action = decideAlertAction(open ? { openedAt: open.openedAt, lastNotifiedAt: open.lastNotifiedAt } : null, ev, now, REPEAT_MINUTES);
        await applyCondition({ ...base, kind: "silent_connection" }, open, action, buildEvidence(ev, { lastInboundAt: lastInbound, lastCrmAt: crmAt, lastEvolutionAt: obs.lastEvolutionAt, state: obs.state, baselinePerHour: baseline }));
      } catch (err) { failures++; deps.log.error({ organizationId: org.id, instanceName: inst.instance_name, errName: (err as Error)?.name }, "silent-connection: avaliação falhou"); }
    }
  }
  // Ciclo concluído sem travar E sem falha de etapa: sinaliza ao monitor externo (só se alguma organização usa o alerta).
  if (anyEnabled && failures === 0 && isCurrent() && deps.heartbeat) { try { await deps.heartbeat(); } catch (err) { deps.log.error({ errName: (err as Error)?.name }, "silent-connection: heartbeat falhou"); } }
}

/** GET sem dados para um monitor externo (ex.: serviço de heartbeat). Nunca lança; timeout curto. */
export async function pingHeartbeat(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<boolean> {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetchImpl(url, { method: "GET", signal: ctl.signal }); return r.ok; } finally { clearTimeout(t); }
  } catch { return false; }
}

export const defaultSilentDeps = (log: Log): SilentDeps => ({
  async listOrganizations() { return (await getAllOrganizations(getAdminClient())) as Array<{ id: string; settings: { silent_connection_alert_mode?: unknown } }>; },
  async listInstances(organizationId) { return (await getInstancesByOrganization(getAdminClient(), organizationId)) as Array<{ id: string; instance_name: string }>; },
  async latestObservation(organizationId, instanceName) {
    const { data, error } = await getAdminClient().from("evolution_connection_observations").select("observed_at, evolution_state, query_ok, last_evolution_message_at")
      .eq("organization_id", organizationId).eq("instance_name", instanceName).order("observed_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as { observed_at: string; evolution_state: string | null; query_ok: boolean; last_evolution_message_at: string | null };
    return { state: r.query_ok ? r.evolution_state : null, queryOk: r.query_ok, lastEvolutionAt: r.last_evolution_message_at ? new Date(r.last_evolution_message_at) : null, observedAt: new Date(r.observed_at) };
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
    const startOfHour = Math.floor((now.getTime() - 3 * hourMs) / hourMs) * hourMs + 3 * hourMs;
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
  async pushReadiness(organizationId) {
    const db = getAdminClient();
    const managers = await listManagerUserIds(db, organizationId);
    let withPush = 0;
    for (const id of managers) { if (await hasPushSubscription(db, organizationId, id)) withPush++; }
    return { vapidConfigured: isPushConfigured(), managers: managers.length, managersWithPush: withPush };
  },
  async getOpenAlert(organizationId, instanceName, kind, mode) {
    const { data, error } = await getAdminClient().from("silent_connection_alerts").select("id, opened_at, last_notified_at")
      .eq("organization_id", organizationId).eq("instance_name", instanceName).eq("kind", kind).eq("mode", mode).is("resolved_at", null).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as { id: string; opened_at: string; last_notified_at: string };
    return { id: r.id, openedAt: new Date(r.opened_at), lastNotifiedAt: new Date(r.last_notified_at) };
  },
  async openAlert(organizationId, instanceName, kind, mode, now, evidence) {
    const { error } = await getAdminClient().from("silent_connection_alerts").insert({ organization_id: organizationId, instance_name: instanceName, kind, mode, opened_at: now.toISOString(), last_notified_at: now.toISOString(), evidence });
    if (!error) return true;
    if ((error as { code?: string }).code === "23505") return false; // outro processo abriu a mesma condição ao mesmo tempo
    throw error;
  },
  async claimRepeat(id, now, repeatMinutes, evidence) {
    const limit = new Date(now.getTime() - repeatMinutes * 60_000).toISOString();
    // UPDATE condicional: o banco serializa; só um processo vê a linha voltar.
    const { data, error } = await getAdminClient().from("silent_connection_alerts").update({ last_notified_at: now.toISOString(), evidence })
      .eq("id", id).is("resolved_at", null).lte("last_notified_at", limit).select("id");
    if (error) throw error;
    return (data ?? []).length === 1;
  },
  async resolveAlert(id, now) {
    const { error } = await getAdminClient().from("silent_connection_alerts").update({ resolved_at: now.toISOString() }).eq("id", id).is("resolved_at", null);
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
  async heartbeat() { const url = process.env.SILENT_CONNECTION_HEARTBEAT_URL; if (url) await pingHeartbeat(url); },
  log,
});

export const MAX_CYCLE_RUN_MS = 15 * 60 * 1000;
/** Um ciclo por vez. Se um ciclo travar (promessa que nunca resolve), ele NÃO fica ocupando o laço para sempre: passado MAX_CYCLE_RUN_MS o
 * próximo tick registra o travamento e inicia outro ciclo (o dedupe é atômico no banco, então a sobreposição é segura). O heartbeat só sai
 * quando um ciclo TERMINA saudável, então enquanto travado o monitor externo deixa de receber pings. */
export function createSilentTicker(run: (isCurrent: () => boolean) => Promise<void>, log: Log, clockMs: () => number = Date.now, maxRunMs = MAX_CYCLE_RUN_MS): () => void {
  let startedAt: number | null = null; let gen = 0;
  return () => {
    if (startedAt !== null) {
      if (clockMs() - startedAt < maxRunMs) return;
      log.error({ runningMinutes: Math.round((clockMs() - startedAt) / 60_000) }, "silent-connection: ciclo anterior travado; iniciando outro");
    }
    const mine = ++gen; startedAt = clockMs();
    // O ciclo ultrapassado (gen diferente) pode terminar depois, mas não é mais "corrente": não emite heartbeat.
    run(() => gen === mine).catch((err) => log.error({ errName: (err as Error)?.name }, "silent-connection: tick failed")).finally(() => { if (gen === mine) startedAt = null; });
  };
}

export const QUERY_TIMEOUT_MS = 20_000;
/** Limite de duração de CADA chamada do ciclo (consulta ao banco, push, heartbeat): estourou = rejeita (conta como falha do ciclo, sem ping).
 * Obs.: o cliente do banco não cancela a consulta; o limite protege o laço, não o servidor. */
export function withDeadline(deps: SilentDeps, ms = QUERY_TIMEOUT_MS): SilentDeps {
  const out: Record<string, unknown> = { log: deps.log };
  for (const [k, v] of Object.entries(deps)) {
    if (typeof v !== "function") continue;
    out[k] = (...args: unknown[]) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error(`timeout ${k}`), { name: "TimeoutError" })), ms);
      (v as (...a: unknown[]) => Promise<unknown>).apply(deps, args).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
    });
  }
  return out as unknown as SilentDeps;
}

/** SILENT_CONNECTION_ALERT_DISABLED=1 no ambiente da API impede até a criação do timer. */
export function startSilentConnectionAlert(log: Log = console): NodeJS.Timeout | null {
  if (process.env.SILENT_CONNECTION_ALERT_DISABLED === "1") return null;
  const deps = defaultSilentDeps(log);
  const guarded = withDeadline(deps);
  const tick = createSilentTicker((isCurrent) => runSilentConnectionCycle(guarded, new Date(), isCurrent), log);
  setTimeout(tick, 120_000).unref(); // depois da primeira observação do monitor (90 s)
  const timer = setInterval(tick, SILENT_CYCLE_MS);
  timer.unref();
  return timer;
}
