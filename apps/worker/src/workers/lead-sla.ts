import { Worker } from "bullmq";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QUEUE_NAMES, type OrganizationSettings } from "@aula-agente/shared";
import { getLeadSlaQueue, getRedisConnection } from "@aula-agente/queue";
import {
  computeEscalationDueAt, computeSlaDueAt, escalateAlertAssignment, flagSlaAlerts, getAdminClient, getOrganizationById, listEscalationCandidates, listExpiredAssignments, redistributeAssignment,
} from "@aula-agente/database";

const SWEEP_EVERY_MS = 60_000;

/**
 * Redistribui atribuições com SLA vencido. O banco é a autoridade: redistribute_assignment trava a linha e só age
 * se ela ainda estiver pendente e vencida, então dois workers (ou um reinício) nunca duplicam a redistribuição.
 */
export async function runLeadSlaSweep(db: SupabaseClient, now = new Date()) {
  // Dono existente e atribuição manual não são redistribuídos: só ganham o alerta de atraso.
  let alerted = 0;
  try { alerted = await flagSlaAlerts(db); } catch (err) { console.error("Lead SLA sweep: flagging alerts failed", err); }
  const expired = await listExpiredAssignments(db);
  const settingsByOrg = new Map<string, Partial<OrganizationSettings>>();
  let redistributed = 0;
  for (const item of expired) {
    try {
      if (!settingsByOrg.has(item.organization_id)) settingsByOrg.set(item.organization_id, (await getOrganizationById(db, item.organization_id)).settings);
      const settings = settingsByOrg.get(item.organization_id)!;
      if (settings.lead_distribution_enabled !== true) continue;
      const created = await redistributeAssignment(db, item.id, computeSlaDueAt(settings, now));
      if (created) redistributed++;
    } catch (err) {
      console.error("Lead SLA sweep: redistribution failed", item.id, err);
    }
  }
  // Estágio 2 da escalada (chave sla_alert_escalation_enabled, desligada por padrão): atribuição 'alert' ainda sem resposta aos 2x o SLA
  // passa ao próximo vendedor, uma vez por cadeia. escalate_alert_assignment trava e relê tudo (só age se ainda pendente, vencida e sem resposta).
  let escalated = 0;
  try {
    for (const item of await listEscalationCandidates(db)) {
      try {
        if (!settingsByOrg.has(item.organization_id)) settingsByOrg.set(item.organization_id, (await getOrganizationById(db, item.organization_id)).settings);
        const settings = settingsByOrg.get(item.organization_id)!;
        if (settings.lead_distribution_enabled !== true || settings.sla_alert_escalation_enabled !== true) continue;
        const escalateAt = computeEscalationDueAt(settings, new Date(item.assigned_at));
        if (escalateAt.getTime() > now.getTime()) continue;
        if (await escalateAlertAssignment(db, item.id, escalateAt, computeSlaDueAt(settings, now))) escalated++;
      } catch (err) {
        console.error("Lead SLA sweep: escalation failed", item.id, err);
      }
    }
  } catch (err) { console.error("Lead SLA sweep: listing escalation candidates failed", err); }
  return { checked: expired.length, redistributed, alerted, escalated };
}

export function startLeadSlaWorker() {
  const worker = new Worker(QUEUE_NAMES.LEAD_SLA, async () => {
    const result = await runLeadSlaSweep(getAdminClient());
    if (result.redistributed || result.alerted || result.escalated) console.log(`Lead SLA: ${result.redistributed} redistribuído(s), ${result.alerted} alerta(s) de atraso, ${result.escalated} escalado(s)`);
  }, { connection: getRedisConnection(), concurrency: 1 });
  getLeadSlaQueue().upsertJobScheduler("lead-sla-scheduler", { every: SWEEP_EVERY_MS }, { name: "sweep-lead-sla" });
  worker.on("failed", (job, err) => console.error(`Lead SLA job ${job?.id} failed:`, err.message));
  console.log("Lead-sla worker started (runs every 60 s)");
  return worker;
}
