import { probeRedis } from "../lib/redis-probe.js";
import { isBusinessOpen, resolveBusinessCalendar } from "@aula-agente/shared";
import type { BusinessCalendar } from "@aula-agente/shared";
import { getAdminClient, getAllOrganizations, getInstancesByOrganization } from "@aula-agente/database";
import { getInstanceStatus, sendText } from "./evolution.service.js";

// Alerta de silêncio. Roda no processo da API (setInterval) e guarda o estado em memória:
// se o Redis cair, o worker cai junto, então nada aqui pode depender de fila nem de Redis
// (o ping do Redis é só uma sonda, com timeout; os avisos vão direto pela Evolution).

export const SILENCE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const NOTIFY_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// Média diária mínima de mensagens de clientes na mesma faixa para o silêncio contar como anormal.
export const MIN_HISTORICAL_AVG = 2;

export type RedisState = "ok" | "down";
export type EvolutionState = "connected" | "disconnected" | "unknown";
export type AlertCode = "silence" | "redis" | "evolution";

export interface HealthInputs {
  now: Date;
  // Expediente aberto agora E durante toda a janela de 2 h (evita falso alarme logo após a abertura).
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
      const hours = Number.isFinite(silentMs) ? `há ${Math.floor(silentMs / 3_600_000)} h` : "há mais de 2 h";
      alerts.push({ code: "silence", message: `Sem mensagens de clientes ${hours}` });
    }
    if (i.redis === "down") alerts.push({ code: "redis", message: "Redis fora do ar ou lento (a fila de mensagens pode estar parada)" });
    if (i.evolution === "disconnected") alerts.push({ code: "evolution", message: "WhatsApp (Evolution) desconectado" });
    else if (i.evolution === "unknown") alerts.push({ code: "evolution", message: "Não foi possível consultar o estado do WhatsApp (Evolution)" });
  }
  return { status: alerts.length ? "warning" : "ok", alerts, reasons: alerts.map((a) => a.message) };
}

export interface NotifyState { lastNotified: Partial<Record<AlertCode, number>>; wasWarning: boolean }
export const newNotifyState = (): NotifyState => ({ lastNotified: {}, wasWarning: false });

// Anti-spam: no máximo 1 aviso a cada 2 h por motivo; 1 mensagem de "normalizado" ao voltar.
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
  log: { error(obj: unknown, msg: string): void };
}

export function isOpenThroughout(now: Date, calendar: BusinessCalendar): boolean {
  for (let m = 0; m <= SILENCE_WINDOW_MS / 60_000; m += 30) {
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
    // Só health_alert_phone (nunca handoff_notification_phone). Vazio: só a faixa no painel.
    const phone = ctx.settings.health_alert_phone?.trim();
    // Sem telefone configurado não há aviso, mas o estado (e o anti-spam) segue valendo.
    notifyStates.set(ctx.organizationId, plan.next);
    if (phone) {
      const at = clock(now, calendar.timeZone);
      try {
        if (plan.send.length) {
          await deps.sendWhatsApp(ctx.organizationId, phone, `Alerta do CRM (${at}): ${plan.send.map((a) => a.message).join("; ")}. Veja Configurações > Recuperar mensagens perdidas.`);
        } else if (plan.recovered) {
          await deps.sendWhatsApp(ctx.organizationId, phone, `CRM normalizado (${at}): as mensagens de clientes voltaram a chegar.`);
        }
      } catch (err) {
        // Nunca derruba o monitor por falha no aviso (a Evolution pode ser justamente o problema).
        deps.log.error({ organizationId: ctx.organizationId, errName: (err as Error)?.name }, "health-monitor: failed to send WhatsApp notice");
      }
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
