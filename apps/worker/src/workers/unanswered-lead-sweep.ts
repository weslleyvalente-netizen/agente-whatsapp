import { Worker } from "bullmq";
import { QUEUE_NAMES, isBusinessOpen, resolveBusinessCalendar } from "@aula-agente/shared";
import { getProcessMessageQueue, getRedisConnection, getUnansweredLeadSweepQueue, type ProcessMessageJobData } from "@aula-agente/queue";
import {
  getAdminClient, getIgnoredContact, getInstanceById, getInstancesByOrganization, getOpenHandoffEvent, hasFrozenContact,
  hasOutboundMessageAfter, listLatestInboundMessages, listUnansweredSweepOrganizations,
  type SweepOrganization, type UnansweredCandidate,
} from "@aula-agente/database";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";
import { decideSweepAction, MAX_AGE_MS, type SkipReason } from "../lib/unanswered-sweep.js";

const SWEEP_EVERY_MS = 5 * 60_000;
const KEY_TTL_SEC = 24 * 60 * 60;
export const MAX_RETRIES_PER_SWEEP = 10;
// Mesmo atraso de agrupamento do webhook (apps/api/src/lib/queue.ts).
const MESSAGE_GROUPING_DELAY_MS = 6000;

export const retriedKey = (messageId: string) => `unanswered-sweep:retried:${messageId}`;
export const alertedKey = (messageId: string) => `unanswered-sweep:alerted:${messageId}`;
/** jobId determinístico (BullMQ não aceita ":" em id customizado). */
export const retryJobId = (messageId: string) => `unanswered-sweep-${messageId}`;

export interface SweepDeps {
  redisReady(): boolean;
  listOrganizations(): Promise<SweepOrganization[]>;
  listInbound(organizationId: string, since: Date): Promise<UnansweredCandidate[]>;
  hasOutboundAfter(conversationId: string, afterIso: string): Promise<boolean>;
  isIgnored(organizationId: string, phone: string): Promise<boolean>;
  isFrozen(organizationId: string, contactId: string): Promise<boolean>;
  hasOpenHandoff(conversationId: string): Promise<boolean>;
  resolveAgentId(evolutionInstanceId: string): Promise<string | null>;
  redis: { get(key: string): Promise<string | null>; setNx(key: string, value: string, ttlSec: number): Promise<boolean>; del(key: string): Promise<void> };
  acquireLock(conversationId: string): Promise<string | null>;
  releaseLock(conversationId: string, value: string): Promise<void>;
  enqueue(data: ProcessMessageJobData, jobId: string): Promise<void>;
  sendAlert(organizationId: string, phone: string, text: string): Promise<void>;
  log: { info(msg: string): void; error(msg: string): void };
}

export interface SweepSummary {
  organizations: number; candidates: number; retried: number; alerted: number; errors: number;
  skipped: Record<string, number>;
}

const last4 = (p: string) => p.replace(/\D/g, "").slice(-4);
const errName = (e: unknown) => (e as Error)?.name ?? "Error";

export async function runUnansweredLeadSweep(deps: SweepDeps, now = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = { organizations: 0, candidates: 0, retried: 0, alerted: 0, errors: 0, skipped: {} };
  const skip = (reason: SkipReason | string) => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; };
  if (!deps.redisReady()) { deps.log.info("unanswered-sweep: redis not ready, skipping run"); return summary; }

  let orgs: SweepOrganization[];
  try { orgs = await deps.listOrganizations(); } catch (err) { deps.log.error(`unanswered-sweep: listing organizations failed (${errName(err)})`); summary.errors++; return summary; }
  // Defesa extra: só quem tem a flag === true.
  orgs = orgs.filter((o) => o.settings?.unanswered_lead_sweep_enabled === true);
  const since = new Date(now.getTime() - MAX_AGE_MS);
  let retriesLeft = MAX_RETRIES_PER_SWEEP;
  const agentCache = new Map<string, string | null>();

  for (const org of orgs) {
    summary.organizations++;
    let inbound: UnansweredCandidate[];
    try { inbound = await deps.listInbound(org.id, since); } catch (err) { deps.log.error(`unanswered-sweep: org ${org.id} listing failed (${errName(err)})`); summary.errors++; continue; }
    const settings = org.settings as { business_calendar?: unknown; health_alert_phone?: string | null };
    const businessOpen = isBusinessOpen(now, resolveBusinessCalendar(settings.business_calendar));

    for (const c of inbound) {
      if (c.organizationId !== org.id) { skip("other_org"); continue; }
      const createdAt = new Date(c.createdAt);
      try {
        summary.candidates++;
        const age = now.getTime() - createdAt.getTime();
        if (age > MAX_AGE_MS) { skip("too_old"); continue; }
        const retriedRaw = await deps.redis.get(retriedKey(c.messageId));
        const retriedAt = retriedRaw && !Number.isNaN(Date.parse(retriedRaw)) ? new Date(retriedRaw) : retriedRaw ? createdAt : null;
        const alerted = (await deps.redis.get(alertedKey(c.messageId))) !== null;
        const hasOutboundAfter = age < 10 * 60_000 ? false : await deps.hasOutboundAfter(c.conversationId, c.createdAt);
        const early = age < 10 * 60_000 || hasOutboundAfter;
        const [ignored, frozen, openHandoff] = early ? [false, false, false] : await Promise.all([
          deps.isIgnored(org.id, c.contactPhone), deps.isFrozen(org.id, c.contactId), deps.hasOpenHandoff(c.conversationId),
        ]);
        const decision = decideSweepAction({
          now, createdAt, content: c.content, mediaType: c.mediaType, hasOutboundAfter, ignored, aiDisabled: c.aiDisabled, frozen,
          isHumanTakeover: c.isHumanTakeover, openHandoff, retriedAt, alerted, businessOpen,
        });
        if (decision.action === "skip") { skip(decision.reason); continue; }

        if (decision.action === "retry") {
          if (retriesLeft <= 0) { skip("retry_cap"); continue; }
          const agentId = agentCache.has(c.evolutionInstanceId) ? agentCache.get(c.evolutionInstanceId)! : await deps.resolveAgentId(c.evolutionInstanceId);
          agentCache.set(c.evolutionInstanceId, agentId);
          if (!agentId) { skip("no_agent"); continue; }
          const lock = await deps.acquireLock(c.conversationId);
          if (!lock) { skip("lock_busy"); continue; }
          try {
            // Reconfere sob o lock: a IA pode ter respondido entre a leitura e agora.
            if (await deps.hasOutboundAfter(c.conversationId, c.createdAt)) { skip("answered"); continue; }
            if (!(await deps.redis.setNx(retriedKey(c.messageId), now.toISOString(), KEY_TTL_SEC))) { skip("already_retried"); continue; }
            try {
              await deps.enqueue({ conversationId: c.conversationId, messageId: c.messageId, agentId, organizationId: org.id }, retryJobId(c.messageId));
            } catch (err) {
              await deps.redis.del(retriedKey(c.messageId)).catch(() => {});
              throw err;
            }
            retriesLeft--; summary.retried++;
            deps.log.info(`unanswered-sweep: retried message ${c.messageId} conv ${c.conversationId} phone ***${last4(c.contactPhone)}`);
          } finally {
            await deps.releaseLock(c.conversationId, lock).catch(() => {});
          }
          continue;
        }

        // alert
        const phone = settings.health_alert_phone?.trim();
        if (!phone) { skip("no_alert_phone"); continue; }
        if (await deps.hasOutboundAfter(c.conversationId, c.createdAt)) { skip("answered"); continue; }
        if (!(await deps.redis.setNx(alertedKey(c.messageId), now.toISOString(), KEY_TTL_SEC))) { skip("already_alerted"); continue; }
        const minutes = Math.floor(age / 60_000);
        const snippet = c.content.replace(/\s+/g, " ").trim().slice(0, 60);
        const text = `Lead sem resposta há ${minutes} min: ${c.contactName ?? "Sem nome"} ${c.contactPhone} (último contato: ${snippet}). Abra o CRM e responda.`;
        try {
          await deps.sendAlert(org.id, phone, text);
        } catch (err) {
          await deps.redis.del(alertedKey(c.messageId)).catch(() => {}); // só fica marcado quando realmente enviou
          throw err;
        }
        summary.alerted++;
        deps.log.info(`unanswered-sweep: alerted message ${c.messageId} conv ${c.conversationId} phone ***${last4(c.contactPhone)}`);
      } catch (err) {
        summary.errors++;
        deps.log.error(`unanswered-sweep: conversation ${c.conversationId} failed (${errName(err)})`);
      }
    }
  }
  deps.log.info(`unanswered-sweep: orgs=${summary.organizations} candidates=${summary.candidates} retried=${summary.retried} alerted=${summary.alerted} errors=${summary.errors} skipped=${JSON.stringify(summary.skipped)}`);
  return summary;
}

async function sendEvolutionAlert(organizationId: string, phone: string, text: string) {
  // Direto pela Evolution, de propósito (como o health-monitor): a fila send-message depende do Redis, que pode ser a causa.
  const instances = (await getInstancesByOrganization(getAdminClient(), organizationId)) as Array<{ instance_name: string; active_agent_id: string | null }>;
  const instance = instances.find((i) => i.active_agent_id);
  if (!instance) throw new Error("no active instance");
  const response = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${instance.instance_name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY! },
    body: JSON.stringify({ number: phone, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Evolution API send error ${response.status}`);
}

export function buildRealDeps(): SweepDeps {
  const db = getAdminClient();
  const redis = getRedisConnection();
  return {
    redisReady: () => redis.status === "ready",
    listOrganizations: () => listUnansweredSweepOrganizations(db),
    listInbound: (orgId, since) => listLatestInboundMessages(db, orgId, since),
    hasOutboundAfter: (conversationId, afterIso) => hasOutboundMessageAfter(db, conversationId, afterIso),
    isIgnored: async (orgId, phone) => !!(await getIgnoredContact(db, orgId, phone)),
    isFrozen: (orgId, contactId) => hasFrozenContact(db, orgId, contactId),
    hasOpenHandoff: async (conversationId) => !!(await getOpenHandoffEvent(db, conversationId)),
    resolveAgentId: async (instanceId) => (await getInstanceById(db, instanceId)).active_agent_id ?? null,
    redis: {
      get: (key) => redis.get(key),
      setNx: async (key, value, ttl) => (await redis.set(key, value, "EX", ttl, "NX")) === "OK",
      del: async (key) => { await redis.del(key); },
    },
    acquireLock: acquireConversationLock,
    releaseLock: releaseConversationLock,
    // Mesmas opções do webhook (enqueueProcessMessage) + jobId determinístico: a reentrada é ignorada pelo BullMQ.
    enqueue: async (data, jobId) => {
      await getProcessMessageQueue().add("process-message", data, {
        jobId,
        delay: MESSAGE_GROUPING_DELAY_MS,
        deduplication: { id: data.conversationId, replace: true, keepLastIfActive: true },
      });
    },
    sendAlert: sendEvolutionAlert,
    log: console,
  };
}

export function startUnansweredLeadSweepWorker() {
  const worker = new Worker(QUEUE_NAMES.UNANSWERED_LEAD_SWEEP, async () => {
    await runUnansweredLeadSweep(buildRealDeps());
  }, { connection: getRedisConnection(), concurrency: 1 });
  getUnansweredLeadSweepQueue().upsertJobScheduler("unanswered-lead-sweep-scheduler", { every: SWEEP_EVERY_MS }, { name: "sweep-unanswered-leads" });
  worker.on("failed", (job, err) => console.error(`Unanswered-lead-sweep job ${job?.id} failed:`, err.message));
  console.log("Unanswered-lead-sweep worker started (runs every 5 min)");
  return worker;
}
