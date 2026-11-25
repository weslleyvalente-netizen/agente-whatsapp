// Encerramento automático depois de 3 follow-ups sem resposta (flag no_reply_closure_enabled, desligada por padrão).
// Ciclo de 15 min: (1) aplica o encerramento das despedidas já CONFIRMADAS (perdido 'sem_resposta' + tarefas automáticas de silêncio
// canceladas; também as da cadência de baixa intenção) e (2) envia no máximo uma despedida por instância por ciclo, em horário
// comercial, dentro do limite diário. Tentativa única: envio ambíguo nunca é repetido (mesmo padrão da cadência e do lote de anúncios).
import type { SupabaseClient } from "@supabase/supabase-js";
import { isWithinBusinessHours, toISODateInTimeZone, validateClosingSettings, DEFAULT_TASK_FOLLOWUP_CONFIG, type Organization } from "@aula-agente/shared";
import { createMessage, updateConversation } from "@aula-agente/database";
import { getSendMessageQueue, getRedisConnection } from "@aula-agente/queue";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";

const INTERVAL_MS = 15 * 60_000;

export interface NoReplyClosureDeps {
  reserve(instanceId: string, now: Date, dailyLimit: number): Promise<boolean>;
  enqueue(job: { conversationId: string; messageId: string; instanceId: string; phone: string; content: string; organizationId: string }): Promise<void>;
  lock(conversationId: string): Promise<string | null>;
  unlock(conversationId: string, token: string): Promise<void>;
}

export const defaultDeps: NoReplyClosureDeps = {
  async reserve(instanceId, now, dailyLimit) {
    const r = await getRedisConnection().eval(`
      if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
      if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return 0 end
      redis.call('SET', KEYS[1], '1', 'PX', ARGV[1]); redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 259200); return 1
    `, 2, `no-reply-closure:interval:${instanceId}`, `no-reply-closure:daily:${instanceId}:${toISODateInTimeZone(now)}`, INTERVAL_MS, dailyLimit);
    return Number(r) === 1;
  },
  async enqueue(job) {
    await getSendMessageQueue().add("send-message", job, { attempts: 1, jobId: `no-reply-closure-${job.messageId}` });
  },
  lock: (id) => acquireConversationLock(id),
  unlock: (id, token) => releaseConversationLock(id, token),
};

export interface NoReplyClosureResult { applied: number; lost: number; queued: number }

/** Passo 1: despedidas confirmadas desde o início configurado e ainda não aplicadas. */
export async function applyConfirmedClosures(db: SupabaseClient, org: Pick<Organization, "id" | "settings">): Promise<{ applied: number; lost: number }> {
  const out = { applied: 0, lost: 0 };
  const startedAt = org.settings.no_reply_closure_started_at;
  if (org.settings.no_reply_closure_enabled !== true || !startedAt) return out;
  const { data, error } = await db.from("messages").select("id,metadata").eq("organization_id", org.id).in("role", ["agent", "human_agent"])
    .gte("created_at", startedAt).not("evolution_message_id", "is", null).or("metadata->no_reply_closure.not.is.null,metadata->low_intent_followup->>stage.eq.3")
    .is("metadata->closure_applied_at", null).limit(50);
  if (error) throw error;
  for (const m of data ?? []) {
    const r = await db.rpc("apply_no_reply_closure", { p_message: m.id });
    if (r.error) { console.error("[no-reply-closure] apply failed", m.id, r.error); continue; }
    out.applied++; out.lost += Number(r.data ?? 0);
  }
  return out;
}

export async function runNoReplyClosureCheck(db: SupabaseClient, org: Pick<Organization, "id" | "settings">, now = new Date(), window = { start: 8, end: 20 }, deps: NoReplyClosureDeps = defaultDeps): Promise<NoReplyClosureResult> {
  const result: NoReplyClosureResult = { applied: 0, lost: 0, queued: 0 };
  if (org.settings.no_reply_closure_enabled !== true || !org.settings.no_reply_closure_started_at) return result;
  const a = await applyConfirmedClosures(db, org);
  result.applied = a.applied; result.lost = a.lost;
  if (!isWithinBusinessHours(now, window.start, window.end)) return result;

  const closing = validateClosingSettings(org.settings.sales_low_intent_closing_message, 1);
  const wait = Math.max(24, Number(org.settings.no_reply_closure_wait_hours ?? 24));
  const dailyLimit = Math.max(1, Math.min(40, org.settings.task_followup_daily_limit ?? DEFAULT_TASK_FOLLOWUP_CONFIG.daily_limit));
  const cand = await db.rpc("no_reply_closure_candidates", { p_org: org.id, p_now: now.toISOString(), p_wait_hours: wait, p_limit: 20 });
  if (cand.error) throw cand.error;
  const usedInstances = new Set<string>();
  for (const c of (cand.data ?? []) as Array<{ conversation_id: string; instance_id: string; followup_days: number }>) {
    if (usedInstances.has(c.instance_id)) continue;
    const token = await deps.lock(c.conversation_id);
    if (!token) continue;
    try {
      // Reconfere sob a trava (o cliente pode ter respondido entre a lista e agora).
      const again = await db.rpc("no_reply_closure_candidates", { p_org: org.id, p_now: now.toISOString(), p_wait_hours: wait, p_limit: 1, p_conversation: c.conversation_id });
      if (again.error) throw again.error;
      const cur = (again.data ?? [])[0] as { conversation_id: string; instance_id: string; phone: string; followup_days: number; anchor: string; opportunity_id: string | null } | undefined;
      if (!cur) continue;
      if (!(await deps.reserve(cur.instance_id, now, dailyLimit))) { usedInstances.add(cur.instance_id); continue; }
      usedInstances.add(cur.instance_id);
      const message = await createMessage(db, {
        conversation_id: cur.conversation_id, organization_id: org.id, evolution_message_id: null, role: "agent", content: closing.message, media_url: null, media_type: null,
        // opportunity_id: o negócio que esta despedida encerra (o único aberto do grupo no envio, ou nenhum). O apply só mexe nele.
        metadata: { no_reply_closure: { anchor: cur.anchor, followup_days: cur.followup_days, opportunity_id: cur.opportunity_id ?? null, queued_at: now.toISOString() } },
      } as any);
      await deps.enqueue({ conversationId: cur.conversation_id, messageId: message.id, instanceId: cur.instance_id, phone: cur.phone, content: closing.message, organizationId: org.id });
      await updateConversation(db, cur.conversation_id, { last_message_at: now.toISOString() } as any);
      console.log("[no-reply-closure] queued", JSON.stringify({ org: org.id, conversation: cur.conversation_id, followup_days: cur.followup_days, message: message.id }));
      result.queued++;
    } catch (error) {
      console.error("[no-reply-closure] conversation deferred", c.conversation_id, error);
    } finally {
      await deps.unlock(c.conversation_id, token);
    }
  }
  return result;
}
