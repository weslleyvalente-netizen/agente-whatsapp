import { getAdminClient, getAllOrganizations, getInstancesByOrganization } from "@aula-agente/database";
import {
  classifyObserveError, observeConnectionState, observeDisconnection, observeLatestReceivedAt,
} from "./evolution.service.js";

// Monitoramento da conexão do Evolution. Roda no processo da API (setInterval), como o alerta de silêncio.
// Para cada instância de organizações com settings.evolution_monitor_enabled === true (desligado por padrão) grava uma
// linha em evolution_connection_observations: só estados e horários em UTC, nunca conteúdo de mensagem, telefone ou chave.
//
// LIMITAÇÃO: é consulta periódica (a cada 5 min). Não assinamos CONNECTION_UPDATE (a instância só envia MESSAGES_UPSERT/UPDATE),
// e a Evolution só informa a ÚLTIMA desconexão, não o histórico. Duas quedas entre observações aparecem como uma só.
// disconnect_since_previous marca quando o horário da última desconexão mudou desde a observação anterior (reconexão rápida).

export const OBSERVE_INTERVAL_MS = 5 * 60 * 1000;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ObservationRow {
  organization_id: string;
  instance_name: string;
  observed_at: string;
  evolution_state: string | null;
  query_ok: boolean;
  query_error_kind: string | null;
  disconnection_at: string | null;
  disconnection_reason_code: number | null;
  disconnection_error_kind: string | null;
  disconnect_since_previous: boolean | null;
  last_crm_message_at: string | null;
  last_evolution_message_at: string | null;
  evolution_message_error_kind: string | null;
}

interface MonitorLog { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void }

export interface MonitorDeps {
  connectionState(instanceName: string): Promise<string | null>;
  disconnection(instanceName: string): Promise<{ at: Date | null; reasonCode: number | null }>;
  latestStoredReceivedAt(instanceName: string): Promise<Date | null>;
  lastCrmMessageAt(organizationId: string, instanceId: string): Promise<Date | null>;
  /** undefined = nunca houve observação; null = houve, sem desconexão registrada. */
  previousDisconnectionAt(organizationId: string, instanceName: string): Promise<Date | null | undefined>;
  insert(row: ObservationRow): Promise<void>;
  prune(olderThan: Date): Promise<void>;
  listOrganizations(): Promise<Array<{ id: string; settings: { evolution_monitor_enabled?: boolean } }>>;
  listInstances(organizationId: string): Promise<Array<{ id: string; instance_name: string }>>;
  log: MonitorLog;
}

export interface InstanceContext { organizationId: string; instanceName: string; instanceId: string }

export async function observeInstance(deps: MonitorDeps, ctx: InstanceContext, now: Date = new Date()): Promise<ObservationRow> {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const row: ObservationRow = {
    organization_id: ctx.organizationId, instance_name: ctx.instanceName, observed_at: now.toISOString(),
    evolution_state: null, query_ok: false, query_error_kind: null,
    disconnection_at: null, disconnection_reason_code: null, disconnection_error_kind: null, disconnect_since_previous: null,
    last_crm_message_at: null, last_evolution_message_at: null, evolution_message_error_kind: null,
  };
  const [state, disc, evoLast, crmLast, prev] = await Promise.allSettled([
    deps.connectionState(ctx.instanceName),
    deps.disconnection(ctx.instanceName),
    deps.latestStoredReceivedAt(ctx.instanceName),
    deps.lastCrmMessageAt(ctx.organizationId, ctx.instanceId),
    deps.previousDisconnectionAt(ctx.organizationId, ctx.instanceName),
  ]);

  if (state.status === "fulfilled") {
    if (state.value) { row.evolution_state = state.value; row.query_ok = true; }
    else row.query_error_kind = "invalid_response";
  } else row.query_error_kind = classifyObserveError(state.reason);

  if (disc.status === "fulfilled") {
    row.disconnection_at = iso(disc.value.at);
    row.disconnection_reason_code = disc.value.reasonCode;
    const before = prev.status === "fulfilled" ? prev.value : undefined;
    if (before !== undefined) {
      row.disconnect_since_previous = disc.value.at === null ? false : before === null || disc.value.at.getTime() > before.getTime();
    }
  } else row.disconnection_error_kind = classifyObserveError(disc.reason);

  if (evoLast.status === "fulfilled") row.last_evolution_message_at = iso(evoLast.value);
  else row.evolution_message_error_kind = classifyObserveError(evoLast.reason);

  if (crmLast.status === "fulfilled") row.last_crm_message_at = iso(crmLast.value);
  return row;
}

export async function runObservationCycle(deps: MonitorDeps, now: Date = new Date()): Promise<void> {
  let orgs: Awaited<ReturnType<MonitorDeps["listOrganizations"]>>;
  try {
    orgs = await deps.listOrganizations();
  } catch (err) {
    deps.log.error({ errName: (err as Error)?.name }, "evolution-monitor: failed to list organizations");
    return;
  }
  for (const org of orgs) {
    if (org.settings?.evolution_monitor_enabled !== true) continue;
    let instances: Array<{ id: string; instance_name: string }>;
    try {
      instances = await deps.listInstances(org.id);
    } catch (err) {
      deps.log.error({ organizationId: org.id, errName: (err as Error)?.name }, "evolution-monitor: failed to list instances");
      continue;
    }
    for (const inst of instances) {
      try {
        const row = await observeInstance(deps, { organizationId: org.id, instanceName: inst.instance_name, instanceId: inst.id }, now);
        await deps.insert(row);
        if (row.evolution_state !== "open" || row.disconnect_since_previous === true) {
          deps.log.info({
            organizationId: org.id, instanceName: inst.instance_name, state: row.evolution_state, queryError: row.query_error_kind,
            disconnectionAt: row.disconnection_at, reasonCode: row.disconnection_reason_code, disconnectSincePrevious: row.disconnect_since_previous,
          }, "evolution-monitor: instância fora de 'open' ou com desconexão nova");
        }
      } catch (err) {
        deps.log.error({ organizationId: org.id, instanceName: inst.instance_name, errName: (err as Error)?.name }, "evolution-monitor: observation failed");
      }
    }
  }
  try {
    await deps.prune(new Date(now.getTime() - RETENTION_MS));
  } catch (err) {
    deps.log.error({ errName: (err as Error)?.name }, "evolution-monitor: prune failed");
  }
}

export const defaultMonitorDeps = (log: MonitorLog): MonitorDeps => ({
  connectionState: observeConnectionState,
  disconnection: observeDisconnection,
  latestStoredReceivedAt: observeLatestReceivedAt,
  async lastCrmMessageAt(organizationId, instanceId) {
    const { data, error } = await getAdminClient()
      .from("messages").select("created_at, conversations!inner(evolution_instance_id)")
      .eq("organization_id", organizationId).eq("role", "contact").eq("conversations.evolution_instance_id", instanceId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? new Date((data as { created_at: string }).created_at) : null;
  },
  async previousDisconnectionAt(organizationId, instanceName) {
    const { data, error } = await getAdminClient()
      .from("evolution_connection_observations").select("disconnection_at")
      .eq("organization_id", organizationId).eq("instance_name", instanceName)
      .order("observed_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    const at = (data as { disconnection_at: string | null }).disconnection_at;
    return at ? new Date(at) : null;
  },
  async insert(row) {
    const { error } = await getAdminClient().from("evolution_connection_observations").insert(row);
    if (error) throw error;
  },
  async prune(olderThan) {
    const { error } = await getAdminClient().from("evolution_connection_observations").delete().lt("observed_at", olderThan.toISOString());
    if (error) throw error;
  },
  async listOrganizations() {
    return (await getAllOrganizations(getAdminClient())) as Array<{ id: string; settings: { evolution_monitor_enabled?: boolean } }>;
  },
  async listInstances(organizationId) {
    return (await getInstancesByOrganization(getAdminClient(), organizationId)) as Array<{ id: string; instance_name: string }>;
  },
  log,
});

export function startEvolutionMonitor(log: MonitorLog = console): NodeJS.Timeout {
  const deps = defaultMonitorDeps(log);
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runObservationCycle(deps).catch((err) => log.error({ errName: (err as Error)?.name }, "evolution-monitor: tick failed")).finally(() => { busy = false; });
  };
  // Primeira observação 90 s após o boot (depois do alerta de silêncio e da recuperação), depois a cada 5 min.
  setTimeout(tick, 90_000).unref();
  const timer = setInterval(tick, OBSERVE_INTERVAL_MS);
  timer.unref();
  return timer;
}
