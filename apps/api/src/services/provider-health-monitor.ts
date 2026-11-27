import { getAdminClient, getAllOrganizations, getInstancesByOrganization } from "@aula-agente/database";
import { decryptInstanceToken, uazapiFindMessages, uazapiStatus } from "@aula-agente/agent-runtime";
import { getProcessMessageQueue } from "@aula-agente/queue";
import { evaluateProviderHealth, resolveProviderMonitorMode, type ProviderHealthCondition, type ProviderHealthKind, type ProviderMonitorMode } from "@aula-agente/shared";
import { defaultSilentDeps, type OpenAlert } from "./silent-connection-alert.js";
import { getProcessStartedAt, getWebhookPulse } from "./webhook-pulse.js";

// Monitor de saúde do provedor de WhatsApp (UAZAPI). Complementa o alerta estatístico de silêncio com condições diretas
// (ver packages/shared/src/provider-health.ts): instância desconectada, mensagem na UAZAPI que não chegou ao CRM (webhook não
// entregou), webhook sem eventos depois de envios nossos e fila de processamento represada.
// Modo por organização: settings.provider_health_monitor_mode = off (padrão) | shadow (só grava em silent_connection_alerts) | on (grava e
// avisa gestores por push). Roda no processo da API (setInterval) — o mesmo processo que recebe o webhook e guarda o pulso em memória.
// Nunca envia mensagem de WhatsApp nem reconecta nada: só observa, registra e avisa. A recuperação de mensagens continua com o
// auto-recover (settings.auto_recover_messages_enabled); a evidência registra se ele estava ligado.

export const PROVIDER_CYCLE_MS = 5 * 60 * 1000;
export const PROVIDER_REPEAT_MINUTES = 60;
/** Janela das mensagens enviadas que servem de referência para o pulso do webhook (confirmação de entrega/leitura volta pelo webhook). */
export const OUTBOUND_WINDOW_MIN = 30;
export const OUTBOUND_MIN_AGE_MIN = 5;

interface Log { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void }
export interface ProviderInstance { id: string; instance_name: string; provider?: string | null; provider_token_encrypted?: string | null }

export interface ProviderDeps {
  listOrganizations(): Promise<Array<{ id: string; settings: Record<string, unknown> | null }>>;
  listInstances(organizationId: string): Promise<ProviderInstance[]>;
  providerSnapshot(instance: ProviderInstance, now: Date): Promise<{ ok: boolean; state: string | null; lastInboundAt: Date | null }>;
  crmLastInboundAt(organizationId: string, instanceId: string): Promise<Date | null>;
  /** Envio mais recente do CRM (com id do WhatsApp) com pelo menos OUTBOUND_MIN_AGE_MIN de idade, dentro da janela. */
  recentOutboundAt(organizationId: string, instanceId: string, now: Date): Promise<Date | null>;
  webhookPulseAt(instanceId: string): Date | null;
  processStartedAt(): Date;
  queueSnapshot(now: Date): Promise<{ ok: boolean; waiting: number | null; oldestWaitingAt: Date | null }>;
  autoRecoverEnabled(organizationId: string): Promise<boolean>;
  getOpenAlert(organizationId: string, instanceName: string, kind: ProviderHealthKind, mode: "shadow" | "on"): Promise<OpenAlert | null>;
  openAlert(organizationId: string, instanceName: string, kind: ProviderHealthKind, mode: "shadow" | "on", now: Date, evidence: Record<string, unknown>): Promise<boolean>;
  claimRepeat(id: string, now: Date, repeatMinutes: number, evidence: Record<string, unknown>): Promise<boolean>;
  resolveAlert(id: string, now: Date, expectedLastNotifiedAt: Date): Promise<void>;
  notifyManagers(organizationId: string, payload: { title: string; body: string; url: string; tag: string }): Promise<number>;
  log: Log;
}

export interface ProviderMonitorStatus {
  started: boolean; startedAt: string | null; cycles: number; lastCycleAt: string | null; lastCycleHealthy: boolean | null;
  /** Última avaliação por instância (e "*" para a fila): só tipo e estado, sem dados de cliente. */
  lastConditions: Record<string, Array<{ kind: ProviderHealthKind; status: string }>>;
}
const state: ProviderMonitorStatus = { started: false, startedAt: null, cycles: 0, lastCycleAt: null, lastCycleHealthy: null, lastConditions: {} };
export const getProviderMonitorStatus = (): ProviderMonitorStatus => JSON.parse(JSON.stringify(state));
export const resetProviderMonitorStatus = () => { Object.assign(state, { started: false, startedAt: null, cycles: 0, lastCycleAt: null, lastCycleHealthy: null, lastConditions: {} }); };

const MESSAGES: Record<ProviderHealthKind, { title: string; body: string }> = {
  provider_disconnected: { title: "WhatsApp desconectado", body: "A UAZAPI informa que o WhatsApp da loja não está conectado. Mensagens de clientes não estão chegando." },
  provider_ahead: { title: "Mensagens de clientes não chegaram ao CRM", body: "A UAZAPI recebeu mensagens que não entraram no CRM (webhook não entregou). Confira as conversas e a recuperação." },
  webhook_stalled: { title: "WhatsApp sem retorno de eventos", body: "Enviamos mensagens e nenhum retorno do WhatsApp chegou desde então. O recebimento pode estar parado." },
  queue_backlog: { title: "Mensagens represadas no CRM", body: "Há mensagens de clientes esperando processamento há mais de 5 minutos. A IA e o CRM podem estar atrasados." },
};

async function apply(d: ProviderDeps, org: string, instanceName: string, mode: "shadow" | "on", c: ProviderHealthCondition, extra: Record<string, unknown>, now: Date) {
  if (c.status === "unknown") return;
  const open = await d.getOpenAlert(org, instanceName, c.kind, mode);
  if (c.status === "ok") {
    if (open) {
      await d.resolveAlert(open.id, now, open.lastNotifiedAt);
      d.log.info({ organizationId: org, instanceName, kind: c.kind, mode, durationMinutes: Math.round((now.getTime() - open.openedAt.getTime()) / 60_000) }, "provider-health: condição resolvida");
    }
    return;
  }
  const evidence = { ...c.evidence, reason: c.reason, ...extra };
  let won: boolean;
  if (!open) won = await d.openAlert(org, instanceName, c.kind, mode, now, evidence);
  else if ((now.getTime() - open.lastNotifiedAt.getTime()) / 60_000 >= PROVIDER_REPEAT_MINUTES) won = await d.claimRepeat(open.id, now, PROVIDER_REPEAT_MINUTES, evidence);
  else return;
  if (!won) return;
  if (mode === "shadow") { d.log.info({ organizationId: org, instanceName, kind: c.kind, mode, evidence }, "provider-health: [SOMBRA] avisaria os gestores"); return; }
  try {
    const sent = await d.notifyManagers(org, { ...MESSAGES[c.kind], url: "/", tag: `provider-health-${c.kind}-${instanceName}` });
    d.log.info({ organizationId: org, instanceName, kind: c.kind, pushSent: sent }, "provider-health: aviso enviado");
  } catch (err) { d.log.error({ organizationId: org, instanceName, kind: c.kind, errName: (err as Error)?.name }, "provider-health: falha ao notificar (alerta gravado)"); }
}

export async function runProviderHealthCycle(d: ProviderDeps, now: Date = new Date()): Promise<void> {
  let failures = 0;
  let orgs: Awaited<ReturnType<ProviderDeps["listOrganizations"]>> = [];
  try { orgs = await d.listOrganizations(); } catch (err) { failures++; d.log.error({ errName: (err as Error)?.name }, "provider-health: falha ao listar organizações"); }
  const conditions: ProviderMonitorStatus["lastConditions"] = {};
  for (const org of orgs) {
    const requested: ProviderMonitorMode = resolveProviderMonitorMode(org.settings);
    if (requested === "off") continue;
    const mode = requested;
    let autoRecover = false;
    try { autoRecover = await d.autoRecoverEnabled(org.id); } catch { /* só evidência */ }
    let instances: ProviderInstance[] = [];
    try { instances = (await d.listInstances(org.id)).filter((i) => i.provider === "uazapi"); } catch (err) { failures++; d.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "provider-health: falha ao listar instâncias"); continue; }
    if (instances.length === 0) continue;

    // Fila: uma vez por organização (a fila é do processo, não da instância).
    try {
      const queue = await d.queueSnapshot(now);
      const q = evaluateProviderHealth({ now, processStartedAt: d.processStartedAt(), provider: { ok: true, state: "connected", lastInboundAt: null }, crmLastInboundAt: null, oldestUnconfirmedOutboundAt: null, lastWebhookEventAt: null, queue })
        .find((c) => c.kind === "queue_backlog")!;
      conditions["*"] = [{ kind: q.kind, status: q.status }];
      await apply(d, org.id, "*", mode, q, {}, now);
    } catch (err) { failures++; d.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "provider-health: falha ao avaliar a fila"); }

    for (const inst of instances) {
      try {
        const [provider, crm, outbound] = await Promise.all([
          d.providerSnapshot(inst, now).catch(() => ({ ok: false, state: null, lastInboundAt: null })),
          d.crmLastInboundAt(org.id, inst.id),
          d.recentOutboundAt(org.id, inst.id, now),
        ]);
        const all = evaluateProviderHealth({
          now, processStartedAt: d.processStartedAt(), provider, crmLastInboundAt: crm, oldestUnconfirmedOutboundAt: outbound,
          lastWebhookEventAt: d.webhookPulseAt(inst.id), queue: { ok: true, waiting: 0, oldestWaitingAt: null },
        }).filter((c) => c.kind !== "queue_backlog");
        conditions[inst.instance_name] = all.map((c) => ({ kind: c.kind, status: c.status }));
        for (const c of all) await apply(d, org.id, inst.instance_name, mode, c, { auto_recover_enabled: autoRecover }, now);
      } catch (err) { failures++; d.log.error({ organizationId: org.id, instanceName: inst.instance_name, errName: (err as Error)?.name }, "provider-health: avaliação falhou"); }
    }
  }
  Object.assign(state, { cycles: state.cycles + 1, lastCycleAt: now.toISOString(), lastCycleHealthy: failures === 0, lastConditions: conditions });
}

export const defaultProviderDeps = (log: Log): ProviderDeps => {
  const silent = defaultSilentDeps(log);
  return {
    async listOrganizations() { return (await getAllOrganizations(getAdminClient())) as unknown as Array<{ id: string; settings: Record<string, unknown> | null }>; },
    async listInstances(organizationId) { return (await getInstancesByOrganization(getAdminClient(), organizationId)) as ProviderInstance[]; },
    async providerSnapshot(inst, now) {
      if (!inst.provider_token_encrypted) return { ok: false, state: null, lastInboundAt: null };
      const token = decryptInstanceToken(inst.provider_token_encrypted);
      const status = await uazapiStatus(token);
      // Só a primeira página (mais recentes) das últimas 3 h: basta saber qual é a mensagem de cliente mais nova que a UAZAPI tem.
      const msgs = await uazapiFindMessages(token, { sinceMs: now.getTime() - 3 * 3600_000, untilMs: now.getTime(), pageSize: 100, maxPages: 1 });
      let last = 0;
      for (const m of msgs) {
        const chatid = typeof m.chatid === "string" ? m.chatid : "";
        if (m.fromMe === true || m.isGroup === true || chatid.endsWith("@g.us")) continue;
        const ts = Number(m.messageTimestamp);
        if (!Number.isFinite(ts)) continue;
        last = Math.max(last, ts > 1e11 ? ts : ts * 1000);
      }
      return { ok: true, state: status.status, lastInboundAt: last ? new Date(last) : null };
    },
    crmLastInboundAt: (organizationId, instanceId) => silent.lastCrmInboundAt(organizationId, instanceId),
    async recentOutboundAt(organizationId, instanceId, now) {
      const { data, error } = await getAdminClient().from("messages").select("created_at, conversations!inner(evolution_instance_id)")
        .eq("organization_id", organizationId).in("role", ["agent", "human_agent"]).not("evolution_message_id", "is", null)
        .eq("conversations.evolution_instance_id", instanceId)
        .gte("created_at", new Date(now.getTime() - OUTBOUND_WINDOW_MIN * 60_000).toISOString())
        .lte("created_at", new Date(now.getTime() - OUTBOUND_MIN_AGE_MIN * 60_000).toISOString())
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data ? new Date((data as { created_at: string }).created_at) : null;
    },
    webhookPulseAt: (instanceId) => getWebhookPulse(instanceId)?.lastEventAt ?? null,
    processStartedAt: getProcessStartedAt,
    async queueSnapshot(now) {
      try {
        const q = getProcessMessageQueue();
        const counts = await q.getJobCounts("wait", "delayed");
        // Mais antigo "pronto para rodar": em 'wait' conta a criação; em 'delayed', o horário agendado (criação + atraso de agrupamento).
        const [oldestWait] = await q.getJobs(["wait"], 0, 0, true);
        const delayed = await q.getJobs(["delayed"], 0, 49, true);
        const due = [oldestWait ? oldestWait.timestamp : null, ...delayed.map((j) => j.timestamp + (j.opts?.delay ?? 0))]
          .filter((t): t is number => typeof t === "number" && t <= now.getTime());
        return { ok: true, waiting: (counts.wait ?? 0) + (counts.delayed ?? 0), oldestWaitingAt: due.length ? new Date(Math.min(...due)) : null };
      } catch { return { ok: false, waiting: null, oldestWaitingAt: null }; }
    },
    async autoRecoverEnabled(organizationId) {
      const orgs = (await getAllOrganizations(getAdminClient())) as Array<{ id: string; settings: { auto_recover_messages_enabled?: boolean } | null }>;
      return orgs.find((o) => o.id === organizationId)?.settings?.auto_recover_messages_enabled === true;
    },
    getOpenAlert: (o, i, k, m) => silent.getOpenAlert(o, i, k as never, m),
    openAlert: (o, i, k, m, n, e) => silent.openAlert(o, i, k as never, m, n, e),
    claimRepeat: silent.claimRepeat,
    resolveAlert: silent.resolveAlert,
    notifyManagers: silent.notifyManagers,
    log,
  };
};

/** PROVIDER_HEALTH_MONITOR_DISABLED=1 impede até a criação do timer. Em "off" (padrão) o ciclo não consulta a UAZAPI nem grava nada. */
export function startProviderHealthMonitor(log: Log = console): NodeJS.Timeout | null {
  if (process.env.PROVIDER_HEALTH_MONITOR_DISABLED === "1") return null;
  Object.assign(state, { started: true, startedAt: new Date().toISOString() });
  const deps = defaultProviderDeps(log);
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runProviderHealthCycle(deps).catch((err) => log.error({ errName: (err as Error)?.name }, "provider-health: tick failed")).finally(() => { busy = false; });
  };
  setTimeout(tick, 150_000).unref(); // depois do warmup do pulso e dos outros monitores
  const timer = setInterval(tick, PROVIDER_CYCLE_MS);
  timer.unref();
  return timer;
}
