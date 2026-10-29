import { Worker } from "bullmq";
import { QUEUE_NAMES, isBusinessOpen, resolveBusinessCalendar } from "@aula-agente/shared";
import { getProcessMessageQueue, getRedisConnection, getUnansweredLeadSweepQueue, type ProcessMessageJobData } from "@aula-agente/queue";
import {
  claimPushDedupe, getAckContext, getAdminClient, getIgnoredContact, getInstanceById, getInstancesByOrganization, getOpenHandoffEvent, hasFrozenContact,
  hasOutboundMessageAfter, hasPushSubscription, isPushConfigured, listCurrentMemberIds, listLatestInboundMessages, listStaleUnprocessedRouted,
  listUnansweredSweepOrganizations, releasePushDedupe, sendPushToUser,
  type PushPayload, type SweepOrganization, type UnansweredCandidate,
} from "@aula-agente/database";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";
import { decideSweepAction, ESCALATE_OWNER_AFTER_MS, isClosingAcknowledgement, MAX_AGE_MS, type SkipReason, type SweepFacts } from "../lib/unanswered-sweep.js";

const SWEEP_EVERY_MS = 5 * 60_000;
const KEY_TTL_SEC = 24 * 60 * 60;
export const MAX_RETRIES_PER_SWEEP = 10;
// Mesmo atraso de agrupamento do webhook (apps/api/src/lib/queue.ts).
const MESSAGE_GROUPING_DELAY_MS = 6000;

export const retriedKey = (messageId: string) => `unanswered-sweep:retried:${messageId}`;
export const alertedKey = (messageId: string) => `unanswered-sweep:alerted:${messageId}`;
/** Segundo estágio (resumo ao dono da loja, 60 min): chave própria, para não repetir e não se confundir com o push ao vendedor. */
export const ownerAlertedKey = (messageId: string) => `unanswered-sweep:alerted-owner:${messageId}`;
/** Valor de alertedKey quando o estágio 1 foi entregue por push ao vendedor (habilita o segundo estágio). */
const PUSH_STAGE_PREFIX = "push:";
/** Chave de idempotência do push (push_notification_log), uma por mensagem do cliente. */
export const pushDedupeKey = (messageId: string) => `unanswered:${messageId}`;
export const attemptsKey = (messageId: string) => `unanswered-sweep:attempts:${messageId}`;
/** jobId determinístico (BullMQ não aceita ":" em id customizado). */
export const retryJobId = (messageId: string) => `unanswered-sweep-${messageId}`;
export const MAX_ENQUEUE_ATTEMPTS = 3;
export const MAX_DIGEST_ITEMS = 5;
const STALE_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export interface EnqueueResult { ok: boolean; reason?: string }

/** Erro de envio com resposta definitiva (HTTP 4xx/5xx): a mensagem NÃO foi entregue, então a chave pode ser liberada. */
export class DefinitiveSendError extends Error {}

export interface SweepDeps {
  redisReady(): boolean;
  listOrganizations(): Promise<SweepOrganization[]>;
  listInbound(organizationId: string, since: Date): Promise<UnansweredCandidate[]>;
  /** Mensagens encaminhadas à IA e nunca processadas entre from e to (só para o contador de "mais de 24 h"). */
  listStale(organizationId: string, from: Date, to: Date): Promise<UnansweredCandidate[]>;
  hasOutboundAfter(conversationId: string, afterIso: string): Promise<boolean>;
  isIgnored(organizationId: string, phone: string): Promise<boolean>;
  isFrozen(organizationId: string, contactId: string): Promise<boolean>;
  hasOpenHandoff(conversationId: string): Promise<boolean>;
  /** Contexto de um possível encerramento ("ok"): só é consultado quando o texto já casa com isClosingAcknowledgement. */
  ackContext(conversationId: string, beforeIso: string): Promise<{ earlierInboundUnanswered: boolean; lastOutboundAsksQuestion: boolean }>;
  resolveAgentId(evolutionInstanceId: string): Promise<string | null>;
  redis: {
    get(key: string): Promise<string | null>;
    setNx(key: string, value: string, ttlSec: number): Promise<boolean>;
    del(key: string): Promise<void>;
    incr(key: string, ttlSec: number): Promise<number>;
  };
  acquireLock(conversationId: string): Promise<string | null>;
  releaseLock(conversationId: string, value: string): Promise<void>;
  enqueue(data: ProcessMessageJobData, jobId: string): Promise<EnqueueResult>;
  sendAlert(organizationId: string, phone: string, text: string): Promise<void>;
  /** Vendedor ainda é membro da organização, tem assinatura push ativa e o servidor tem as chaves VAPID? */
  canReceivePush(organizationId: string, userId: string): Promise<boolean>;
  /** Reserva a chave de idempotência do push (push_notification_log). false = já notificado. */
  claimPushDedupe(key: string, userId: string): Promise<boolean>;
  releasePushDedupe(keys: string[]): Promise<void>;
  /** Envia o push; devolve quantos aparelhos receberam (0 = nada entregue). */
  sendPush(organizationId: string, userId: string, payload: PushPayload): Promise<number>;
  log: { info(msg: string): void; error(msg: string): void };
}

export interface SweepSummary {
  organizations: number; candidates: number; retried: number; alerted: number; pushed: number; errors: number;
  skipped: Record<string, number>;
}

const last4 = (p: string) => p.replace(/\D/g, "").slice(-4);
const errText = (e: unknown) => {
  const x = e as { name?: string; message?: string; code?: string } | null;
  return `${x?.name ?? "Error"}${x?.code ? `/${x.code}` : ""}: ${String(x?.message ?? "").replace(/\d{8,}/g, "***").slice(0, 200)}`;
};

/** `key` = chave Redis que marca este item como avisado no resumo (alertedKey no fallback; ownerAlertedKey no segundo estágio). */
interface AlertItem { c: UnansweredCandidate; minutes: number; key: string }

export function buildDigest(items: Array<{ c: UnansweredCandidate; minutes: number }>, moreCount: number, staleCount: number): string {
  const lines = items.map(({ c, minutes }) => {
    const excerpt = c.content.replace(/\s+/g, " ").trim().slice(0, 40) || "(mídia)";
    return `- ${c.contactName ?? "Sem nome"} (final ${last4(c.contactPhone)}), há ${minutes} min: ${excerpt}`;
  });
  const total = items.length + moreCount;
  return [
    `Leads sem resposta (${total}):`, ...lines,
    ...(moreCount > 0 ? [`+${moreCount} outros.`] : []),
    ...(staleCount > 0 ? [`${staleCount} leads com mais de 24 h sem resposta.`] : []),
    "Abra o CRM e responda.",
  ].join("\n");
}

export async function runUnansweredLeadSweep(deps: SweepDeps, now = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = { organizations: 0, candidates: 0, retried: 0, alerted: 0, pushed: 0, errors: 0, skipped: {} };
  const skip = (reason: SkipReason | string, n = 1) => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + n; };
  if (!deps.redisReady()) { deps.log.info("unanswered-sweep: redis not ready, skipping run"); return summary; }

  let orgs: SweepOrganization[];
  try { orgs = await deps.listOrganizations(); } catch (err) { deps.log.error(`unanswered-sweep: listing organizations failed (${errText(err)})`); summary.errors++; return summary; }
  // Defesa extra: só quem tem a flag === true.
  orgs = orgs.filter((o) => o.settings?.unanswered_lead_sweep_enabled === true);
  const since = new Date(now.getTime() - MAX_AGE_MS);
  let retriesLeft = MAX_RETRIES_PER_SWEEP;
  const agentCache = new Map<string, string | null>();

  for (const org of orgs) {
    summary.organizations++;
    let inbound: UnansweredCandidate[];
    try { inbound = await deps.listInbound(org.id, since); } catch (err) { deps.log.error(`unanswered-sweep: org ${org.id} listing failed (${errText(err)})`); summary.errors++; continue; }
    const settings = org.settings as { business_calendar?: unknown; health_alert_phone?: string | null; push_notifications_enabled?: unknown };
    const pushEnabled = settings.push_notifications_enabled === true;
    const businessOpen = isBusinessOpen(now, resolveBusinessCalendar(settings.business_calendar));
    const alertItems: AlertItem[] = [];

    for (const c of inbound) {
      if (c.organizationId !== org.id) { skip("other_org"); continue; }
      const createdAt = new Date(c.createdAt);
      try {
        summary.candidates++;
        const age = now.getTime() - createdAt.getTime();
        if (age > MAX_AGE_MS) { skip("too_old"); continue; }
        const retriedRaw = await deps.redis.get(retriedKey(c.messageId));
        let retriedAt = retriedRaw && !Number.isNaN(Date.parse(retriedRaw)) ? new Date(retriedRaw) : retriedRaw ? createdAt : null;
        // Esgotou as tentativas de enfileirar (BullMQ descartou o job): segue direto para o aviso.
        if (!retriedAt && Number(await deps.redis.get(attemptsKey(c.messageId)) ?? 0) >= MAX_ENQUEUE_ATTEMPTS) retriedAt = createdAt;
        const alertedRaw = await deps.redis.get(alertedKey(c.messageId));
        // Segundo estágio: o vendedor recebeu o push e a mensagem segue sem resposta aos 60 min => resumo ao dono da loja (uma vez).
        const ownerStage = !!alertedRaw?.startsWith(PUSH_STAGE_PREFIX) && age >= ESCALATE_OWNER_AFTER_MS && (await deps.redis.get(ownerAlertedKey(c.messageId))) === null;
        const alerted = alertedRaw !== null && !ownerStage;
        const early = age < 10 * 60_000;
        const hasOutboundAfter = early ? false : await deps.hasOutboundAfter(c.conversationId, c.createdAt);
        const skipHeavy = early || hasOutboundAfter;
        const [ignored, frozen, openHandoff] = skipHeavy ? [false, false, false] : await Promise.all([
          deps.isIgnored(org.id, c.contactPhone), deps.isFrozen(org.id, c.contactId), deps.hasOpenHandoff(c.conversationId),
        ]);
        const facts: SweepFacts = {
          now, createdAt, content: c.content, mediaType: c.mediaType, hasOutboundAfter, aiRouted: !!c.aiRoutedAt, aiProcessed: !!c.aiProcessedAt,
          ignored, aiDisabled: c.aiDisabled, frozen,
          isHumanTakeover: c.isHumanTakeover, openHandoff, retriedAt, alerted, businessOpen,
        };
        let decision = decideSweepAction(facts);
        // Encerramento ("ok", "obrigado") só silencia o AVISO, e só com contexto limpo: sem outra mensagem do cliente pendente
        // antes e sem pergunta nossa por último. A consulta só ocorre quando o aviso sairia e o texto casa com o filtro.
        if (decision.action === "alert" && (!c.mediaType || c.mediaType === "text") && isClosingAcknowledgement(c.content)) {
          const ctx = await deps.ackContext(c.conversationId, c.createdAt);
          if (!ctx.earlierInboundUnanswered && !ctx.lastOutboundAsksQuestion) decision = decideSweepAction({ ...facts, closingAck: true });
        }
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
            let result: EnqueueResult;
            try {
              result = await deps.enqueue({ conversationId: c.conversationId, messageId: c.messageId, agentId, organizationId: org.id }, retryJobId(c.messageId));
            } catch (err) {
              await deps.redis.del(retriedKey(c.messageId)).catch(() => {});
              throw err;
            }
            if (!result.ok) {
              // O BullMQ descartou o job em silêncio (deduplicação apontando para job inexistente): não conta como retry.
              await deps.redis.del(retriedKey(c.messageId)).catch(() => {});
              const n = await deps.redis.incr(attemptsKey(c.messageId), KEY_TTL_SEC);
              deps.log.error(`unanswered-sweep: enqueue dropped (${result.reason ?? "unknown"}) conv ${c.conversationId} msg ${c.messageId} attempt ${n}/${MAX_ENQUEUE_ATTEMPTS}`);
              skip("enqueue_dropped");
              continue;
            }
            retriesLeft--; summary.retried++;
            deps.log.info(`unanswered-sweep: retried msg ${c.messageId} conv ${c.conversationId} phone ***${last4(c.contactPhone)}${result.reason ? ` (${result.reason})` : ""}`);
          } finally {
            await deps.releaseLock(c.conversationId, lock).catch(() => {});
          }
          continue;
        }

        // alert: reconfere e junta ao resumo da organização
        if (await deps.hasOutboundAfter(c.conversationId, c.createdAt)) { skip("answered"); continue; }
        const minutes = Math.floor(age / 60_000);
        if (ownerStage) { alertItems.push({ c, minutes, key: ownerAlertedKey(c.messageId) }); continue; }
        // Estágio 1: push ao vendedor dono da conversa; sem dono/assinatura/push ligado, cai no resumo imediato ao dono da loja.
        if (pushEnabled && c.assignedTo && await deps.canReceivePush(org.id, c.assignedTo)) {
          const r = await pushToSeller(deps, org.id, c, now);
          if (r === "sent") { summary.pushed++; continue; }
          if (r === "duplicate") { skip("already_alerted"); continue; }
        }
        alertItems.push({ c, minutes, key: alertedKey(c.messageId) });
      } catch (err) {
        summary.errors++;
        deps.log.error(`unanswered-sweep: conv ${c.conversationId} msg ${c.messageId} failed (${errText(err)})`);
      }
    }

    if (alertItems.length) {
      try { await sendDigest(deps, org, settings, alertItems, now, summary, skip); }
      catch (err) { summary.errors++; deps.log.error(`unanswered-sweep: org ${org.id} digest failed (${errText(err)})`); }
    }
  }
  deps.log.info(`unanswered-sweep: orgs=${summary.organizations} candidates=${summary.candidates} retried=${summary.retried} alerted=${summary.alerted} pushed=${summary.pushed} errors=${summary.errors} skipped=${JSON.stringify(summary.skipped)}`);
  return summary;
}

/**
 * Estágio 1: "Cliente sem resposta" por push ao vendedor dono. A chave de aviso (valor "push:<data>") é marcada ANTES do envio;
 * falha de envio ou nenhum aparelho entregue libera as chaves (e, sem aparelho, o chamador cai no resumo ao dono da loja).
 */
async function pushToSeller(deps: SweepDeps, organizationId: string, c: UnansweredCandidate, now: Date): Promise<"sent" | "duplicate" | "fallback"> {
  const userId = c.assignedTo!;
  if (!(await deps.redis.setNx(alertedKey(c.messageId), `${PUSH_STAGE_PREFIX}${now.toISOString()}`, KEY_TTL_SEC))) return "duplicate";
  const dedupe = pushDedupeKey(c.messageId);
  const undo = async () => {
    await deps.releasePushDedupe([dedupe]).catch(() => {});
    await deps.redis.del(alertedKey(c.messageId)).catch(() => {});
  };
  try {
    if (!(await deps.claimPushDedupe(dedupe, userId))) return "duplicate"; // já notificado (chave Redis expirou): nada a repetir; a marca "push:" segue habilitando o estágio 2
    const excerpt = c.content.replace(/\s+/g, " ").trim().slice(0, 40) || "mídia";
    const sent = await deps.sendPush(organizationId, userId, {
      title: `Cliente sem resposta: ${c.contactName?.trim() || "Sem nome"} (${excerpt})`, body: "Toque para responder.",
      url: `/inbox?id=${c.conversationId}`, tag: c.conversationId,
    });
    if (sent <= 0) { await undo(); return "fallback"; }
  } catch (err) {
    await undo();
    throw err;
  }
  deps.log.info(`unanswered-sweep: push sent org ${organizationId} conv ${c.conversationId} msg ${c.messageId}`);
  return "sent";
}

async function sendDigest(
  deps: SweepDeps, org: SweepOrganization, settings: { health_alert_phone?: string | null },
  items: AlertItem[], now: Date, summary: SweepSummary, skip: (r: string, n?: number) => void,
) {
  const phone = settings.health_alert_phone?.trim();
  if (!phone) { skip("no_alert_phone", items.length); return; }
  items.sort((a, b) => b.minutes - a.minutes); // mais antigos primeiro
  const claimed: AlertItem[] = [];
  let more = 0;
  for (const item of items) {
    if (claimed.length >= MAX_DIGEST_ITEMS) { more++; continue; } // sem chave: entram no próximo resumo
    // A chave é marcada ANTES do envio: um timeout da Evolution não pode repetir o aviso a cada varredura.
    if (await deps.redis.setNx(item.key, now.toISOString(), KEY_TTL_SEC)) claimed.push(item);
    else skip("already_alerted");
  }
  if (!claimed.length) return;
  let stale = 0;
  try {
    const old = await deps.listStale(org.id, new Date(now.getTime() - STALE_LOOKBACK_MS), new Date(now.getTime() - MAX_AGE_MS));
    for (const o of old) if (!(await deps.hasOutboundAfter(o.conversationId, o.createdAt))) stale++;
  } catch (err) { deps.log.error(`unanswered-sweep: org ${org.id} stale count failed (${errText(err)})`); }
  const release = async () => { for (const i of claimed) await deps.redis.del(i.key).catch(() => {}); };
  let text: string;
  try { text = buildDigest(claimed, more, stale); } catch (err) { await release(); throw err; } // nada foi enviado
  try {
    await deps.sendAlert(org.id, phone, text);
  } catch (err) {
    // Só mantém as chaves em erro ambíguo (timeout/rede com a requisição já emitida); qualquer falha anterior ao envio libera.
    if (err instanceof DefinitiveSendError) await release();
    throw err;
  }
  summary.alerted += claimed.length;
  deps.log.info(`unanswered-sweep: digest sent org ${org.id} items=${claimed.length} more=${more} stale=${stale}`);
}

export async function sendEvolutionAlert(organizationId: string, phone: string, text: string) {
  // Direto pela Evolution, de propósito (como o health-monitor): a fila send-message depende do Redis, que pode ser a causa.
  // Tudo que falha ANTES de a requisição HTTP ser emitida é DefinitiveSendError (nada foi enviado: as chaves são liberadas).
  let url: string; let apiKey: string; let instanceName: string;
  try {
    const instances = (await getInstancesByOrganization(getAdminClient(), organizationId)) as Array<{ instance_name: string; active_agent_id: string | null }>;
    const instance = instances.find((i) => i.active_agent_id);
    if (!instance) throw new Error("no active instance");
    if (!process.env.EVOLUTION_API_URL || !process.env.EVOLUTION_API_KEY) throw new Error("Evolution env not configured");
    instanceName = instance.instance_name; url = `${process.env.EVOLUTION_API_URL}/message/sendText/${instanceName}`; apiKey = process.env.EVOLUTION_API_KEY;
  } catch (err) {
    throw new DefinitiveSendError(`pre-send failure: ${(err as Error)?.message ?? "unknown"}`);
  }
  // Daqui em diante um timeout/erro de rede é ambíguo (pode ter entregado): erro comum, as chaves ficam.
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ number: phone, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new DefinitiveSendError(`Evolution API send error ${response.status}`);
}

export function buildRealDeps(): SweepDeps {
  const db = getAdminClient();
  const redis = getRedisConnection();
  return {
    redisReady: () => redis.status === "ready",
    listOrganizations: () => listUnansweredSweepOrganizations(db),
    listInbound: (orgId, since) => listLatestInboundMessages(db, orgId, since),
    listStale: (orgId, from, to) => listStaleUnprocessedRouted(db, orgId, from, to),
    hasOutboundAfter: (conversationId, afterIso) => hasOutboundMessageAfter(db, conversationId, afterIso),
    isIgnored: async (orgId, phone) => !!(await getIgnoredContact(db, orgId, phone)),
    isFrozen: (orgId, contactId) => hasFrozenContact(db, orgId, contactId),
    hasOpenHandoff: async (conversationId) => !!(await getOpenHandoffEvent(db, conversationId)),
    ackContext: (conversationId, beforeIso) => getAckContext(db, conversationId, beforeIso),
    resolveAgentId: async (instanceId) => (await getInstanceById(db, instanceId)).active_agent_id ?? null,
    redis: {
      get: (key) => redis.get(key),
      setNx: async (key, value, ttl) => (await redis.set(key, value, "EX", ttl, "NX")) === "OK",
      del: async (key) => { await redis.del(key); },
      incr: async (key, ttl) => { const n = await redis.incr(key); if (n === 1) await redis.expire(key, ttl); return n; },
    },
    acquireLock: acquireConversationLock,
    releaseLock: releaseConversationLock,
    // Mesmas opções do webhook (enqueueProcessMessage) + jobId determinístico: a reentrada é ignorada pelo BullMQ.
    enqueue: async (data, jobId) => {
      const queue = getProcessMessageQueue();
      const job = await queue.add("process-message", data, {
        jobId,
        delay: MESSAGE_GROUPING_DELAY_MS,
        deduplication: { id: data.conversationId, replace: true, keepLastIfActive: true },
      });
      if (job?.id === jobId) return { ok: true };
      // O BullMQ devolveu o id de OUTRO job (deduplicação): vale só se esse job ainda existe (vai tratar a mensagem pendente).
      const existing = job?.id ? await queue.getJob(job.id) : undefined;
      return existing ? { ok: true, reason: "merged_into_existing_job" } : { ok: false, reason: "dedup_orphan" };
    },
    sendAlert: sendEvolutionAlert,
    canReceivePush: async (orgId, userId) => {
      if (!isPushConfigured()) return false;
      if (!(await listCurrentMemberIds(db, orgId, [userId])).has(userId)) return false;
      return hasPushSubscription(db, orgId, userId);
    },
    claimPushDedupe: (key, userId) => claimPushDedupe(db, key, userId),
    releasePushDedupe: (keys) => releasePushDedupe(db, keys),
    sendPush: async (orgId, userId, payload) => (await sendPushToUser(db, userId, payload, { organizationId: orgId })).sent,
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
