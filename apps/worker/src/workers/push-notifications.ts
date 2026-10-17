import { Worker } from "bullmq";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QUEUE_NAMES, type OrganizationSettings } from "@aula-agente/shared";
import { getPushNotificationsQueue, getRedisConnection } from "@aula-agente/queue";
import {
  claimPushDedupe, getAdminClient, getOrganizationById, isPushConfigured, listCustomerMessageCandidates,
  listNewAssignmentCandidates, listSlaRiskCandidates, sendPushToUser, type PushCandidate,
} from "@aula-agente/database";

const SWEEP_EVERY_MS = 30_000;
const STARTUP_LOOKBACK_MS = 2 * 60_000;
// Sobreposição entre varreduras: eventos gravados com atraso ainda entram; a idempotência (dedupe_key) evita repetição.
const OVERLAP_MS = 10_000;
const SLA_WINDOW_MINUTES = 15;

/** Cursor em memória: ao subir olha só os últimos 2 min, para não inundar após um reinício. */
export function createPushCursor(startedAt = new Date()) {
  return { since: new Date(startedAt.getTime() - STARTUP_LOOKBACK_MS) };
}

/** Varredura dos três gatilhos (lead novo, mensagem do cliente, SLA em risco). Cada vendedor só recebe o que é dele. */
export async function runPushSweep(db: SupabaseClient, cursor: { since: Date }, now = new Date()) {
  if (!isPushConfigured()) return { sent: 0, skipped: true as const };
  const since = cursor.since;
  const sources: Array<[string, () => Promise<PushCandidate[]>]> = [
    ["assignments", () => listNewAssignmentCandidates(db, since)],
    ["messages", () => listCustomerMessageCandidates(db, since)],
    ["sla", () => listSlaRiskCandidates(db, now, SLA_WINDOW_MINUTES)],
  ];
  const settingsByOrg = new Map<string, Partial<OrganizationSettings>>();
  let sent = 0;
  for (const [name, load] of sources) {
    let candidates: PushCandidate[];
    try { candidates = await load(); } catch (err) { console.error(`Push sweep: ${name} trigger failed`, err); continue; }
    for (const c of candidates) {
      try {
        if (!settingsByOrg.has(c.organizationId)) settingsByOrg.set(c.organizationId, (await getOrganizationById(db, c.organizationId)).settings);
        if (settingsByOrg.get(c.organizationId)!.push_notifications_enabled !== true) continue;
        let fresh = false;
        for (const key of c.dedupeKeys) if (await claimPushDedupe(db, key, c.userId)) fresh = true;
        if (!fresh) continue;
        const result = await sendPushToUser(db, c.userId, { title: c.title, body: c.body, url: c.url, tag: c.tag });
        sent += result.sent;
      } catch (err) {
        console.error(`Push sweep: ${name} delivery failed`, err);
      }
    }
  }
  cursor.since = new Date(now.getTime() - OVERLAP_MS);
  return { sent, skipped: false as const };
}

export function startPushNotificationsWorker() {
  const cursor = createPushCursor();
  const worker = new Worker(QUEUE_NAMES.PUSH_NOTIFICATIONS, async () => {
    const result = await runPushSweep(getAdminClient(), cursor);
    if (result.sent) console.log(`Push: ${result.sent} notificação(ões) enviada(s)`);
  }, { connection: getRedisConnection(), concurrency: 1 });
  getPushNotificationsQueue().upsertJobScheduler("push-notifications-scheduler", { every: SWEEP_EVERY_MS }, { name: "sweep-push" });
  worker.on("failed", (job, err) => console.error(`Push job ${job?.id} failed:`, err.message));
  console.log("Push-notifications worker started (runs every 30 s)");
  return worker;
}
