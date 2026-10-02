import type {SupabaseClient} from '@supabase/supabase-js';
import {isUnengagedAdContact,canCloseAdTasks,validateClosingSettings,toISODateInTimeZone,type Organization,type Message,type ScheduledAdClosureBatch,type ScheduledAdClosureRecipient} from '@aula-agente/shared';
import type {SendMessageJobData} from '@aula-agente/queue';
import {getSendMessageQueue,getRedisConnection} from '@aula-agente/queue';
import {getAdClosureState,getAdClosureMessages,claimAdClosureSend,completeAdClosureTasks,getOrganizationById,getMessageById,createMessage,setMessageEvolutionId,updateMessageContent,addTaskEvent} from '@aula-agente/database';
import {acquireConversationLock,releaseConversationLock} from '../lib/lock.js';

function batchFor(org:Pick<Organization,'id'|'settings'>):ScheduledAdClosureBatch|null {
 const b=org.settings.scheduled_ad_closure_batch;if(!b)return null;
 const start=Date.parse(b.startAt),end=Date.parse(b.endAt);
 if(!b.id || !Number.isFinite(start) || !Number.isFinite(end) || end<=start || end-start>86400000 || !Number.isFinite(b.intervalMinutes) || b.intervalMinutes<15 || !Array.isArray(b.recipients) || b.recipients.length>40)throw new Error('Fila de despedidas inválida.');
 validateClosingSettings(b.message,1);
 const contacts=new Set<string>();let previous=-Infinity;
 for(const r of b.recipients){const at=Date.parse(r.scheduledAt);if(!r.contactId || !r.conversationId || !r.initialMessageId || !r.tasks?.length || !Number.isFinite(at) || at<start || at>=end || contacts.has(r.contactId) || at-previous<b.intervalMinutes*60000)throw new Error('Destinatário/horário inválido.');contacts.add(r.contactId);previous=at;}
 return b;
}
async function reconcile(db:SupabaseClient,org:Pick<Organization,'id'|'settings'>,r:ScheduledAdClosureRecipient,message:Message,state:Awaited<ReturnType<typeof getAdClosureState>>) {
 if(!message.evolution_message_id || !message.metadata?.scheduled_ad_closure?.attempted_at || !isUnengagedAdContact(state,r.initialMessageId))return;
 await completeAdClosureTasks(db,org.id,r,message);
}

// Called by the existing 15-minute worker. Persisted approved recipients only:
// restarting/deploying never adds recipients or sends catch-up bursts.
export async function runScheduledAdClosureCheck(db:SupabaseClient,org:Pick<Organization,'id'|'settings'>,now=new Date()):Promise<Set<string>> {
 const handled=new Set<string>();const batch=batchFor(org);if(!batch)return handled;
 let queued=false;
 for(const r of batch.recipients){
  try{
   let state=await getAdClosureState(db,org.id,r.contactId);
   if(!isUnengagedAdContact(state,r.initialMessageId))continue;
   handled.add(r.conversationId); // includes paused, scheduled and already sent
   const messages=await getAdClosureMessages(db,org.id,r.conversationId,batch.id);
   const existing=messages[0];
   if(existing?.evolution_message_id){await reconcile(db,org,r,existing,state);continue;}
   if(existing?.metadata?.scheduled_ad_closure?.attempted_at || existing?.metadata?.scheduled_ad_closure?.cancelled_at)continue;
   if(queued || org.settings.scheduled_ad_closure_enabled!==true || now.getTime()<Date.parse(r.scheduledAt) || now.getTime()>=Date.parse(batch.endAt) || !canCloseAdTasks(state.tasks,r.tasks))continue;
   const lock=await acquireConversationLock(r.conversationId);if(!lock)continue;
   try{
    state=await getAdClosureState(db,org.id,r.contactId);
    if(!isUnengagedAdContact(state,r.initialMessageId) || !canCloseAdTasks(state.tasks,r.tasks))continue;
    const c=state.conversations.find(c=>c.id===r.conversationId);
    if(!c?.evolution_instance_id || !state.contact.phone)continue;
    const current=(await getAdClosureMessages(db,org.id,r.conversationId,batch.id))[0];
    if(current?.evolution_message_id || current?.metadata?.scheduled_ad_closure?.attempted_at || current?.metadata?.scheduled_ad_closure?.cancelled_at)continue;
    const message=current??await createMessage(db,{conversation_id:c.id,organization_id:org.id,evolution_message_id:null,role:'agent',content:batch.message,media_type:null,media_url:null,metadata:{scheduled_ad_closure:{batch_id:batch.id}}});
    // A never-started job can be queued on the next tick. Networking attempts
    // are CAS-reserved on the message and are NEVER retried automatically.
    await getSendMessageQueue().add('send-message',{conversationId:c.id,messageId:message.id,instanceId:c.evolution_instance_id,phone:state.contact.phone,content:message.content,organizationId:org.id},{attempts:1,jobId:`ad-close-${message.id}-${Math.floor(now.getTime()/900000)}`});
    queued=true;
   }finally{await releaseConversationLock(r.conversationId,lock);}
  }catch(error){handled.add(r.conversationId);console.error('Scheduled closure deferred',r.conversationId,error);}
 }
 return handled;
}

export async function processScheduledAdClosure(db:SupabaseClient,data:SendMessageJobData,message:Message,send:(content:string,signal:AbortSignal)=>Promise<unknown>,now=new Date()):Promise<void> {
 const org=await getOrganizationById(db,data.organizationId);const batch=batchFor(org);
 const r=batch?.recipients.find(r=>r.conversationId===data.conversationId);
 if(!batch || !r || message.organization_id!==org.id || message.conversation_id!==r.conversationId || message.metadata?.scheduled_ad_closure?.batch_id!==batch.id || message.content!==batch.message)return;
 const lock=await acquireConversationLock(r.conversationId);if(!lock)return;
 try{
  const state=await getAdClosureState(db,org.id,r.contactId);
  if(message.evolution_message_id){await reconcile(db,org,r,message,state);return;}
  if(message.metadata.scheduled_ad_closure.attempted_at || message.metadata.scheduled_ad_closure.cancelled_at)return;
  if(org.settings.scheduled_ad_closure_enabled!==true || now.getTime()<Date.parse(r.scheduledAt) || now.getTime()>=Date.parse(batch.endAt))return;
  const c=state.conversations.find(c=>c.id===r.conversationId);
  if(!c || c.evolution_instance_id!==data.instanceId || state.contact.phone!==data.phone || !isUnengagedAdContact(state,r.initialMessageId) || !canCloseAdTasks(state.tasks,r.tasks)){
   await updateMessageContent(db,message.id,message.content,{...message.metadata,scheduled_ad_closure:{...message.metadata.scheduled_ad_closure,cancelled_at:now.toISOString()}});return;
  }
  const reserved=await getRedisConnection().eval(`
   if redis.call('EXISTS',KEYS[1])==1 then return 0 end
   if tonumber(redis.call('GET',KEYS[2]) or '0')>=tonumber(ARGV[2]) then return 0 end
   redis.call('SET',KEYS[1],'1','PX',ARGV[1]);redis.call('INCR',KEYS[2]);redis.call('EXPIRE',KEYS[2],259200);return 1;
  `,2,`ad-closure:interval:${data.instanceId}`,`ad-closure:daily:${data.instanceId}:${toISODateInTimeZone(now)}`,Math.max(900000,batch.intervalMinutes*60000),Math.min(40,org.settings.task_followup_daily_limit??40));
  if(Number(reserved)!==1 || !await claimAdClosureSend(db,message,now.toISOString()))return;
  let response:unknown;
  try{response=await send(message.content,AbortSignal.timeout(30000));}
  catch(error){
   for(const t of r.tasks){try{await addTaskEvent(db,{task_id:t.id,organization_id:org.id,event_type:'updated',note:JSON.stringify({source:'scheduled_ad_closure',batch_id:batch.id,message_id:message.id,status:'unconfirmed',message:'Envio não confirmado. Tarefa mantida aberta; não reenviar automaticamente.'}),created_by_type:'ai',created_by_id:null});}catch(eventError){console.error('Closure ambiguity event failed',t.id,eventError);}}
   throw error;
  }
  const id=(response as any)?.key?.id;
  if(typeof id==='string' && id)await setMessageEvolutionId(db,message.id,id);
  const confirmed=await getMessageById(db,message.id);
  if(confirmed?.evolution_message_id)await reconcile(db,org,r,confirmed,await getAdClosureState(db,org.id,r.contactId));
 }finally{await releaseConversationLock(r.conversationId,lock);}
}

export async function shouldSuppressScheduledAdLegacySend(db:SupabaseClient,orgId:string,conversationId:string):Promise<boolean>{
 const org=await getOrganizationById(db,orgId);const batch=batchFor(org);const r=batch?.recipients.find(r=>r.conversationId===conversationId);
 if(!r)return false;
 return isUnengagedAdContact(await getAdClosureState(db,orgId,r.contactId),r.initialMessageId);
}
