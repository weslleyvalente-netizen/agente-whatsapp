import { Worker } from "bullmq";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QUEUE_NAMES } from "@aula-agente/shared";
import { getPushNotificationsQueue, getRedisConnection } from "@aula-agente/queue";
import {
  claimPushDedupe, deletePushSubscriptionsForUser, getAdminClient, isPushConfigured, listCurrentMemberIds,
  listCustomerMessageCandidates, listNewAssignmentCandidates, listPushEnabledOrganizationIds, listSlaRiskCandidates,
  purgePushNotificationLog, releasePushDedupe, sendPushToUser, type PushCandidate,
} from "@aula-agente/database";

const SWEEP_EVERY_MS = 30_000;
const STARTUP_LOOKBACK_MS = 2 * 60_000;
// Sobreposição entre varreduras: eventos gravados com atraso ainda entram; a idempotência (dedupe_key) evita repetição.
const OVERLAP_MS = 10_000;
const SLA_WINDOW_MINUTES = 15;

// Notificações por vendedor por varredura; acima disso vira um único resumo ("N novos leads").
const MAX_INDIVIDUAL_PER_USER = 5;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PURGE_EVERY_MS = 60 * 60_000;

export interface PushCursor { assignmentsSince: Date; messagesSince: Date; lastPurgeAt: Date | null }

/** Cursores em memória: ao subir olham só os últimos 2 min, para não inundar após um reinício. */
export function createPushCursor(startedAt = new Date()): PushCursor {
  const since = new Date(startedAt.getTime() - STARTUP_LOOKBACK_MS);
  return { assignmentsSince: since, messagesSince: since, lastPurgeAt: null };
}

type Fresh = { organizationId: string; userId: string; items: Array<{ c: PushCandidate; keys: string[] }> };

/**
 * Varredura dos três gatilhos (lead novo, mensagem do cliente, SLA em risco). Só organizações com a flag ligada;
 * cada vendedor só recebe o que é dele e só enquanto for membro da organização.
 */
export async function runPushSweep(db: SupabaseClient, cursor: PushCursor, now = new Date()) {
  if (!isPushConfigured()) return { sent: 0, skipped: true as const };
  if (!cursor.lastPurgeAt || now.getTime() - cursor.lastPurgeAt.getTime() >= PURGE_EVERY_MS) {
    try { await purgePushNotificationLog(db, new Date(now.getTime() - LOG_RETENTION_MS)); cursor.lastPurgeAt = now; }
    catch (err) { console.error("Push sweep: log purge failed", err); }
  }
  const orgIds = await listPushEnabledOrganizationIds(db);
  if (!orgIds.length) return { sent: 0, skipped: false as const };

  const advanced = new Date(now.getTime() - OVERLAP_MS);
  const candidates: PushCandidate[] = [];
  const run = async (name: string, load: () => Promise<PushCandidate[] | { candidates: PushCandidate[]; truncatedAt: Date | null }>, advance?: (to: Date) => void) => {
    try {
      const r = await load();
      if (Array.isArray(r)) { candidates.push(...r); return; }
      candidates.push(...r.candidates);
      advance?.(r.truncatedAt ?? advanced);
    } catch (err) { console.error(`Push sweep: ${name} trigger failed`, err); } // o cursor desta fonte não avança
  };
  await run("assignments", () => listNewAssignmentCandidates(db, cursor.assignmentsSince, orgIds), (to) => { cursor.assignmentsSince = to; });
  await run("messages", () => listCustomerMessageCandidates(db, cursor.messagesSince, orgIds), (to) => { cursor.messagesSince = to; });
  await run("sla", () => listSlaRiskCandidates(db, now, orgIds, SLA_WINDOW_MINUTES));

  // Membros atuais por organização (um vendedor removido não recebe nada e perde as assinaturas).
  const usersByOrg = new Map<string, Set<string>>();
  for (const c of candidates) usersByOrg.set(c.organizationId, (usersByOrg.get(c.organizationId) ?? new Set()).add(c.userId));
  const members = new Map<string, Set<string>>();
  for (const [orgId, users] of usersByOrg) {
    try {
      const current = await listCurrentMemberIds(db, orgId, [...users]);
      members.set(orgId, current);
      for (const userId of users) if (!current.has(userId)) await deletePushSubscriptionsForUser(db, orgId, userId);
    } catch (err) { console.error("Push sweep: membership check failed", err); members.set(orgId, new Set()); }
  }

  const fresh = new Map<string, Fresh>();
  for (const c of candidates) {
    if (!members.get(c.organizationId)?.has(c.userId)) continue;
    try {
      const keys: string[] = [];
      for (const key of c.dedupeKeys) if (await claimPushDedupe(db, key, c.userId)) keys.push(key);
      if (!keys.length) continue;
      const id = `${c.organizationId}|${c.userId}`;
      const entry = fresh.get(id) ?? { organizationId: c.organizationId, userId: c.userId, items: [] };
      entry.items.push({ c, keys });
      fresh.set(id, entry);
    } catch (err) { console.error("Push sweep: dedupe failed", err); }
  }

  let sent = 0;
  for (const { organizationId, userId, items } of fresh.values()) {
    const batches = items.length <= MAX_INDIVIDUAL_PER_USER
      ? items.map(({ c, keys }) => ({ payload: { title: c.title, body: c.body, url: c.url, tag: c.tag }, keys }))
      : [{
          payload: {
            title: items.every(i => i.c.kind === "assign") ? `${items.length} novos leads` : `${items.length} novas notificações`,
            body: "Toque para abrir.", url: "/inbox", tag: "push-summary",
          },
          keys: items.flatMap(i => i.keys),
        }];
    for (const { payload, keys } of batches) {
      try {
        sent += (await sendPushToUser(db, userId, payload, { organizationId })).sent;
      } catch (err) {
        console.error("Push sweep: delivery failed", err);
        try { await releasePushDedupe(db, keys); } catch (releaseErr) { console.error("Push sweep: releasing keys failed", releaseErr); }
      }
    }
  }
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
