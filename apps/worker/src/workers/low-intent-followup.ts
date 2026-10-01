import { hasFrozenContact, getStaleWaitingConversations, getConversationById, getRecentMessages, getLastContactMessage, getOpenTaskByConversation, getOpenHandoffEvent, createMessage, updateConversation, type getAdminClient } from "@aula-agente/database";
import { decideLowIntentCadence, isWithinBusinessHours, toISODateInTimeZone, DEFAULT_TASK_FOLLOWUP_CONFIG, type Organization, type Message } from "@aula-agente/shared";
import { getSendMessageQueue, getRedisConnection } from "@aula-agente/queue";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";

async function readAll(query: () => any): Promise<any[]> {
 const rows: any[] = [];
 for (let start=0; ; start+=500) {
  const {data,error}=await query().range(start,start+499); if(error) throw error;
  rows.push(...(data ?? [])); if(!data || data.length<500) return rows;
 }
}
const TEXTS = {
 1: "Ficou alguma dúvida sobre o atendimento? Se quiser continuar, estou por aqui.",
 2: "Passando para saber se você ainda quer continuar o atendimento. Se precisar de ajuda para dar o próximo passo, pode me chamar.",
 3: "Vou encerrar este atendimento por enquanto para não te incomodar com novas mensagens. Quando quiser retomar, estamos à disposição!",
};
// true means this silence belongs to the no-task cadence, including waiting,
// delivery ambiguity, or a finished sequence. The legacy task flow must not run.
export async function runLowIntentFollowup(db: ReturnType<typeof getAdminClient>, org: Pick<Organization,"id"|"settings">, conversationId:string, anchor:string, now=new Date(), window={start:8,end:20}):Promise<boolean> {
 if (org.settings.sales_low_intent_cadence_enabled !== true) return false;
 const lock=await acquireConversationLock(conversationId); if(!lock) return true;
 try {
  const c=await getConversationById(db,conversationId);
  if(c.organization_id && c.organization_id !== org.id) return true;
  if(await hasFrozenContact(db,org.id,c.contact_id,true)) return true;
  const [handoff,task,latest,lastContact,opportunities]=await Promise.all([
   getOpenHandoffEvent(db,conversationId), getOpenTaskByConversation(db,org.id,conversationId), getRecentMessages(db,conversationId,1), getLastContactMessage(db,conversationId),
   readAll(()=>db.from("opportunities").select("status,stage,waiting_on,sale_amount,credit_amount").eq("organization_id",org.id).eq("contact_id",c.contact_id).order("id")),
  ]);
  const openOpportunities = opportunities.filter(o => o.status === "open");
  if (opportunities.length && !openOpportunities.length) return true;
  if(c.is_human_takeover || c.wa_contacts?.ai_disabled || handoff || task) return false;
  if(openOpportunities.length>1 || openOpportunities.some(o=> !["interest_received","qualification"].includes(o.stage) || o.waiting_on && o.waiting_on !== "customer" || Number(o.sale_amount)>0 || Number(o.credit_amount)>0)) return false;
  if(latest[0]?.role !== "agent" || (lastContact?.created_at ?? c.created_at) !== anchor) return true;
  if(!isWithinBusinessHours(now,window.start,window.end)) return true;
  const history: Message[]=await readAll(()=>db.from("messages").select("role,created_at,metadata,evolution_message_id").eq("organization_id",org.id).eq("conversation_id",conversationId).gte("created_at",anchor).order("created_at"));
  const original=history.filter(m=>m.role==="agent" && !m.metadata?.low_intent_followup).at(-1);
  if(!original || !org.settings.sales_low_intent_cadence_started_at || original.created_at < org.settings.sales_low_intent_cadence_started_at) return true;
  const attempts=history.filter(m=>m.metadata?.low_intent_followup?.anchor === anchor).map(m=>({stage:m.metadata!.low_intent_followup!.stage,confirmed:!!m.evolution_message_id}));
  const stage=decideLowIntentCadence((now.getTime()-new Date(original.created_at).getTime())/3600000,attempts);
  if(!stage || !c.wa_contacts?.phone) return true;
  const interval = Math.max(1, org.settings.task_followup_min_interval_seconds ?? DEFAULT_TASK_FOLLOWUP_CONFIG.min_interval_seconds);
  const dailyLimit = Math.max(1, org.settings.task_followup_daily_limit ?? DEFAULT_TASK_FOLLOWUP_CONFIG.daily_limit);
  const reserved = await getRedisConnection().eval(`
    if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
    if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return 0 end
    redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
    redis.call('INCR', KEYS[2])
    redis.call('EXPIRE', KEYS[2], 259200)
    return 1
  `, 2, `low-intent:interval:${c.evolution_instance_id}`, `low-intent:daily:${c.evolution_instance_id}:${toISODateInTimeZone(now)}`, interval * 1000, dailyLimit);
  if (Number(reserved) !== 1) return true;
  const message=await createMessage(db,{conversation_id:c.id,organization_id:org.id,evolution_message_id:null,role:"agent",content:TEXTS[stage],media_url:null,media_type:null,metadata:{low_intent_followup:{anchor,stage}}});
  // Reserve the attempt before enqueueing; a timeout/crash never sends a second
  // copy. Ambiguous attempts stay pending and are not automatically retried.
  await getSendMessageQueue().add("send-message",{conversationId:c.id,messageId:message.id,instanceId:c.evolution_instance_id,phone:c.wa_contacts.phone,content:message.content ?? TEXTS[stage],organizationId:org.id},{attempts:1,jobId:`low-intent-${message.id}`});
  await updateConversation(db,c.id,{last_message_at:now.toISOString()});
  return true;
 } finally { await releaseConversationLock(conversationId,lock); }
}

export async function runLowIntentCadenceCheck(db: ReturnType<typeof getAdminClient>, org: Pick<Organization,"id"|"settings">, agentId:string, now=new Date(), window={start:8,end:20}):Promise<Set<string>> {
 const handled = new Set<string>();
 if (org.settings.sales_low_intent_cadence_enabled !== true) return handled;
 const cutoff = new Date(now.getTime() - 3600000).toISOString();
 const candidates = await getStaleWaitingConversations(db, org.id, agentId, cutoff);
 for (const c of candidates) {
  try {
   const last = await getLastContactMessage(db,c.id);
   if (await runLowIntentFollowup(db,org,c.id,last?.created_at ?? c.created_at,now,window)) handled.add(c.id);
  } catch (error) {
   // An uncertain send must not fall through to the legacy task flow.
   handled.add(c.id); console.error("Low-intent followup failed",c.id,error);
  }
 }
 return handled;
}
