import { probeRedis } from "../lib/redis-probe.js";
import { isBusinessOpen, resolveBusinessCalendar } from "@aula-agente/shared";
import type { BusinessCalendar } from "@aula-agente/shared";
import { getAdminClient, getAllOrganizations, getInstancesByOrganization, sendPushToUser } from "@aula-agente/database";
import { getInstanceStatus, sendText } from "./evolution.service.js";

// Alerta de silêncio. Roda no processo da API (setInterval) e guarda o estado em memória:
// se o Redis cair, o worker cai junto, então nada aqui pode depender de fila nem de Redis
// (o ping do Redis é só uma sonda, com timeout; os avisos vão direto pela Evolution).

export const SILENCE_WINDOW_MS = 45 * 60 * 1000;
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
// Média diária mínima de mensagens de clientes na mesma faixa (45 min) para o silêncio contar como anormal.
// Mantido em 2 por decisão: com a janela de 45 min dá ~13,5% de falso alarme, igual ao limite antigo.
export const MIN_HISTORICAL_AVG = 2;
// Destino do push (página de Configurações, onde fica o cartão "Recuperar mensagens perdidas") e tag que agrupa os avisos.
export const HEALTH_PUSH_URL = "/settings";
export const HEALTH_PUSH_TAG = "health-alert";

export type RedisState = "ok" | "down";
export type EvolutionState = "connected" | "disconnected" | "unknown";
export type AlertCode = "silence" | "redis" | "evolution";

export interface HealthInputs {
  now: Date;
  // Expediente aberto agora E durante toda a janela de silêncio (45 min) (evita falso alarme logo após a abertura).
  businessOpenThroughout: boolean;
  lastCustomerMessageAt: Date | null;
  // Média diária de mensagens de clientes na mesma faixa de horário nos 7 dias anteriores.
  historicalAvgInWindow: number;
  redis: RedisState;
  evolution: EvolutionState;
}

export interface HealthAlert { code: AlertCode; message: string }
export interface HealthDecision { status: "ok" | "warning"; alerts: HealthAlert[]; reasons: string[] }

export function decideHealth(i: HealthInputs): HealthDecision {
  const alerts: HealthAlert[] = [];
  if (i.businessOpenThroughout) {
    const silentMs = i.lastCustomerMessageAt ? i.now.getTime() - i.lastCustomerMessageAt.getTime() : Infinity;
    if (silentMs >= SILENCE_WINDOW_MS && i.historicalAvgInWindow >= MIN_HISTORICAL_AVG) {
      const ago = !Number.isFinite(silentMs) ? `há mais de ${SILENCE_WINDOW_MS / 60_000} min`
        : silentMs < 3_600_000 ? `há ${Math.floor(silentMs / 60_000)} min` : `há ${Math.floor(silentMs / 3_600_000)} h`;
      // Evolution "open" e Redis ok mas silêncio: a sessão pode estar travada (incidente de 06/11).
      const hint = i.evolution === "connected" && i.redis === "ok"
        ? "; o WhatsApp consta conectado mas pode não estar recebendo (reconectar pelo QR Code)" : "";
      alerts.push({ code: "silence", message: `Sem mensagens de clientes ${ago}${hint}` });
    }
    if (i.redis === "down") alerts.push({ code: "redis", message: "Redis fora do ar ou lento (a fila de mensagens pode estar parada)" });
    if (i.evolution === "disconnected") alerts.push({ code: "evolution", message: "WhatsApp (Evolution) desconectado" });
    else if (i.evolution === "unknown") alerts.push({ code: "evolution", message: "Não foi possível consultar o estado do WhatsApp (Evolution)" });
  }
  return { status: alerts.length ? "warning" : "ok", alerts, reasons: alerts.map((a) => a.message) };
}

export interface NotifyState { lastNotified: Partial<Record<AlertCode, number>>; wasWarning: boolean }
export const newNotifyState = (): NotifyState => ({ lastNotified: {}, wasWarning: false });

// Anti-spam: no máximo 1 aviso a cada 30 min por motivo; 1 mensagem de "normalizado" ao voltar.
// Fora do expediente (businessOpenThroughout=false) o estado "warning" anterior é mantido: sumir o alerta
// porque fechou o expediente não é normalização e não deve gerar o aviso de "normalizado".
export function planNotifications(state: NotifyState, decision: HealthDecision, nowMs: number, businessOpenThroughout = true): {
  send: HealthAlert[]; recovered: boolean; next: NotifyState;
} {
  const send = decision.alerts.filter((a) => {
    const last = state.lastNotified[a.code];
    return last === undefined || nowMs - last >= NOTIFY_COOLDOWN_MS;
  });
  const lastNotified = { ...state.lastNotified };
  for (const a of send) lastNotified[a.code] = nowMs;
  if (!businessOpenThroughout) return { send, recovered: false, next: { lastNotified, wasWarning: state.wasWarning } };
  const recovered = state.wasWarning && decision.status === "ok";
  return { send, recovered, next: { lastNotified, wasWarning: decision.status === "warning" } };
}

export interface HealthSnapshot {
  status: "ok" | "warning";
  reasons: string[];
  lastCustomerMessageAt: string | null;
  redis: RedisState;
  evolution: EvolutionState;
  checkedAt: string;
}

export interface OrgHealthContext {
  organizationId: string;
  settings: { business_calendar?: unknown; health_alert_phone?: string | null };
}

export interface HealthDeps {
  lastCustomerMessageAt(organizationId: string): Promise<Date | null>;
  historicalAvgInWindow(organizationId: string, now: Date): Promise<number>;
  pingRedis(): Promise<RedisState>;
  evolutionState(organizationId: string): Promise<EvolutionState>;
  sendWhatsApp(organizationId: string, phone: string, text: string): Promise<void>;
  // Push para owners/admins da organização. Canal independente do WhatsApp.
  sendPush(organizationId: string, text: { title: string; body: string }): Promise<void>;
  log: { error(obj: unknown, msg: string): void };
}

export function isOpenThroughout(now: Date, calendar: BusinessCalendar): boolean {
  for (let m = 0; m <= SILENCE_WINDOW_MS / 60_000; m += 15) {
    if (!isBusinessOpen(new Date(now.getTime() - m * 60_000), calendar)) return false;
  }
  return true;
}

function clock(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(now);
  } catch {
    return now.toISOString();
  }
}

const snapshots = new Map<string, HealthSnapshot>();
const notifyStates = new Map<string, NotifyState>();
export const getSnapshot = (organizationId: string) => snapshots.get(organizationId);
export function resetHealthMonitorState() { snapshots.clear(); notifyStates.clear(); }

export async function evaluateOrganization(
  deps: HealthDeps,
  ctx: OrgHealthContext,
  opts: { now?: Date; notify: boolean }
): Promise<HealthSnapshot> {
  const now = opts.now ?? new Date();
  const calendar = resolveBusinessCalendar(ctx.settings.business_calendar);
  const [last, avg, redis, evolution] = await Promise.all([
    deps.lastCustomerMessageAt(ctx.organizationId).catch(() => null),
    deps.historicalAvgInWindow(ctx.organizationId, now).catch(() => 0),
    deps.pingRedis().catch((): RedisState => "down"),
    deps.evolutionState(ctx.organizationId).catch((): EvolutionState => "unknown"),
  ]);
  const openThroughout = isOpenThroughout(now, calendar);
  const decision = decideHealth({
    now, businessOpenThroughout: openThroughout,
    lastCustomerMessageAt: last, historicalAvgInWindow: avg, redis, evolution,
  });
  const snapshot: HealthSnapshot = {
    status: decision.status, reasons: decision.reasons,
    lastCustomerMessageAt: last ? last.toISOString() : null, redis, evolution, checkedAt: now.toISOString(),
  };
  snapshots.set(ctx.organizationId, snapshot);

  if (opts.notify) {
    const plan = planNotifications(notifyStates.get(ctx.organizationId) ?? newNotifyState(), decision, now.getTime(), openThroughout);
    // Só health_alert_phone (nunca handoff_notification_phone). Vazio: sem WhatsApp, mas o push segue.
    const phone = ctx.settings.health_alert_phone?.trim();
    // O estado (e o anti-spam) segue valendo mesmo sem canal configurado.
    notifyStates.set(ctx.organizationId, plan.next);
    const body = plan.send.length ? plan.send.map((a) => a.message).join("; ") : null;
    const pushText = body !== null ? { title: "Alerta do CRM", body }
      : plan.recovered ? { title: "CRM normalizado", body: "As mensagens de clientes voltaram a chegar." } : null;
    if (pushText) {
      const at = clock(now, calendar.timeZone);
      const whatsText = body !== null
        ? `Alerta do CRM (${at}): ${body}. Veja Configurações > Recuperar mensagens perdidas.`
        : `CRM normalizado (${at}): as mensagens de clientes voltaram a chegar.`;
      // Canais independentes: a falha de um nunca derruba o monitor nem impede o outro.
      // Em paralelo: o push não espera a chamada HTTP do WhatsApp (que pode demorar ou travar).
      const errLog = (msg: string) => (err: unknown) =>
        deps.log.error({ organizationId: ctx.organizationId, errName: (err as Error)?.name }, msg);
      await Promise.allSettled([
        phone
          ? deps.sendWhatsApp(ctx.organizationId, phone, whatsText).catch(errLog("health-monitor: failed to send WhatsApp notice"))
          : Promise.resolve(),
        deps.sendPush(ctx.organizationId, pushText).catch(errLog("health-monitor: failed to send push notice")),
      ]);
    }
  }
  return snapshot;
}

// ---- dependências reais ----

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function activeInstances(organizationId: string) {
  const list = await getInstancesByOrganization(getAdminClient(), organizationId);
  return (list as Array<{ instance_name: string; active_agent_id: string | null }>).filter((i) => i.active_agent_id);
}

export const defaultDeps: HealthDeps = {
  async lastCustomerMessageAt(organizationId) {
    const { data, error } = await getAdminClient()
      .from("messages").select("created_at").eq("organization_id", organizationId).eq("role", "contact")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? new Date(data.created_at as string) : null;
  },
  async historicalAvgInWindow(organizationId, now) {
    const db = getAdminClient();
    const counts = await Promise.all(Array.from({ length: 7 }, async (_, k) => {
      const end = new Date(now.getTime() - (k + 1) * 86_400_000);
      const start = new Date(end.getTime() - SILENCE_WINDOW_MS);
      const { count, error } = await db.from("messages").select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId).eq("role", "contact")
        .gte("created_at", start.toISOString()).lt("created_at", end.toISOString());
      if (error) throw error;
      return count ?? 0;
    }));
    return counts.reduce((a, b) => a + b, 0) / 7;
  },
  async pingRedis() {
    // Falha única não vira alerta (deploy, reconexão): confirma uma segunda vez após uma pausa curta.
    if (await probeRedis()) return "ok";
    await new Promise((r) => setTimeout(r, 8_000));
    return (await probeRedis()) ? "ok" : "down";
  },
  async evolutionState(organizationId) {
    const instances = await activeInstances(organizationId);
    if (instances.length === 0) return "connected"; // nada para monitorar
    let allOpen = true;
    for (const i of instances) {
      const status = await withTimeout(getInstanceStatus(i.instance_name), 8000);
      if (status?.instance?.state !== "open") allOpen = false;
    }
    return allOpen ? "connected" : "disconnected";
  },
  async sendWhatsApp(organizationId, phone, text) {
    // Direto pela Evolution, de propósito: a fila send-message depende do Redis, que pode ser a causa do alerta.
    const [instance] = await activeInstances(organizationId);
    if (!instance) throw new Error("no active instance");
    await sendText(instance.instance_name, { number: phone, text });
  },
  async sendPush(organizationId, text) {
    const db = getAdminClient();
    const { data, error } = await db.from("organization_members").select("user_id")
      .eq("organization_id", organizationId).in("role", ["owner", "admin"]);
    if (error) throw Object.assign(new Error("db_error"), { name: (error as { code?: string }).code ?? "db_error" });
    const userIds = ((data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
    // Sem assinatura (sent 0) ou sem chaves VAPID não é erro: sendPushToUser é inerte.
    const results = await Promise.allSettled(userIds.map((userId) =>
      sendPushToUser(db, userId, { ...text, url: HEALTH_PUSH_URL, tag: HEALTH_PUSH_TAG }, { organizationId })));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) console.error({ organizationId, failed, total: results.length }, "health-monitor: push failed for some admins");
    if (results.length && failed === results.length) throw (results[0] as PromiseRejectedResult).reason;
  },
  log: console,
};

export async function runHealthChecks(deps: HealthDeps = defaultDeps): Promise<void> {
  const orgs = await getAllOrganizations(getAdminClient());
  for (const org of orgs) {
    try {
      await evaluateOrganization(deps, { organizationId: org.id, settings: org.settings }, { notify: true });
    } catch (err) {
      deps.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "health-monitor: check failed");
    }
  }
}

export function startHealthMonitor(log: { error(obj: unknown, msg: string): void } = console): NodeJS.Timeout {
  const tick = () => { runHealthChecks({ ...defaultDeps, log }).catch((err) => log.error({ errName: (err as Error)?.name }, "health-monitor: run failed")); };
  // Primeira checagem logo após o boot (30 s) e depois a cada 5 min.
  setTimeout(tick, 30_000).unref();
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}

// Para a rota /health: usa o último resultado; se ainda não houve checagem (API recém-iniciada), calcula sem avisar.
export async function getOrComputeSnapshot(ctx: OrgHealthContext, deps: HealthDeps = defaultDeps): Promise<HealthSnapshot> {
  return snapshots.get(ctx.organizationId) ?? evaluateOrganization(deps, ctx, { notify: false });
}
