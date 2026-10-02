import type {SupabaseClient} from '@supabase/supabase-js';
import type {AdClosureState,Message,Task} from '@aula-agente/shared';
import {fetchAllPages} from '../pagination.js';
import {getIgnoredContact} from './ignored-contacts.js';
export async function getAdClosureState(db:SupabaseClient,orgId:string,contactId:string):Promise<AdClosureState&{tasks:Task[];contact:{phone:string;name:string|null};conversations:any[]}> {
 async function rows(table:string,select='*',scope='contact_id',ids?:string[]) {return fetchAllPages<any>(async(from,to)=>{let q=db.from(table).select(select).eq('organization_id',orgId);q=ids?q.in(scope,ids):q.eq(scope,contactId);const {data,error}=await q.order('id').range(from,to);if(error)throw error;return data??[];});}
 const {data:contact,error}=await db.from('wa_contacts').select('phone,name,ai_disabled').eq('organization_id',orgId).eq('id',contactId).single();if(error)throw error;
 const conversations=await rows('conversations');const ids=conversations.map(c=>c.id);
 if(!ids.length)throw new Error('Contato sem conversa.');
 const [messages,tasks,opportunities,qualifications,handoffs,ignored]=await Promise.all([
 rows('messages','*','conversation_id',ids),rows('tasks'),rows('opportunities','id,status,stage,waiting_on,frozen_until'),rows('conversation_qualifications','id,cpf_encrypted,birth_date,down_payment_amount,target_installment_amount,bid_amount,usage_purpose,urgency,human_locked_fields'),rows('handoff_events','id,trigger_type','conversation_id',ids),getIgnoredContact(db,orgId,contact.phone)
 ]);
 return {contact,conversations,messages,tasks,opportunities,qualifications,handoffs,ignored:!!ignored,aiDisabled:contact.ai_disabled===true};
}
export async function getAdClosureMessages(db:SupabaseClient,orgId:string,conversationId:string,batchId:string) {
 const {data,error}=await db.from('messages').select('*').eq('organization_id',orgId).eq('conversation_id',conversationId).eq('metadata->scheduled_ad_closure->>batch_id',batchId).order('created_at');if(error)throw error;return data as Message[];
}
// Persistent compare-and-set before networking: BullMQ redelivery cannot send
// a second copy, even after a timeout, crash or loss of the Redis limiter.
export async function claimAdClosureSend(db:SupabaseClient,message:Message,at:string):Promise<boolean> {
 const {data,error}=await db.from('messages').update({created_at:at,metadata:{...message.metadata,scheduled_ad_closure:{...message.metadata!.scheduled_ad_closure!,attempted_at:at}}}).eq('id',message.id).eq('organization_id',message.organization_id).eq('metadata->scheduled_ad_closure->>batch_id',message.metadata!.scheduled_ad_closure!.batch_id).is('evolution_message_id',null).is('metadata->scheduled_ad_closure->>attempted_at',null).is('metadata->scheduled_ad_closure->>cancelled_at',null).select('id').maybeSingle();if(error)throw error;return !!data;
}

// No deletes. Updated-at CAS preserves a task edited/reassigned after approval.
// completed_at anchors recovery if the event write failed after the CAS.
export async function completeAdClosureTasks(db:SupabaseClient,orgId:string,recipient:import('@aula-agente/shared').ScheduledAdClosureRecipient,message:Message) {
 const {getMessageById}=await import('./messages.js');
 const {addTaskEvent,getTaskEvents}=await import('./tasks.js');
 const recorded=await getMessageById(db,message.id);
 const attempt=recorded?.metadata?.scheduled_ad_closure?.attempted_at;
 if(!recorded?.evolution_message_id || !attempt || recorded.organization_id!==orgId || recorded.conversation_id!==recipient.conversationId)return;
 for(const snapshot of recipient.tasks){
  const {data:task,error}=await db.from('tasks').select('*').eq('organization_id',orgId).eq('contact_id',recipient.contactId).eq('id',snapshot.id).single();if(error)throw error;
  const marker=`ad-closure:${recorded.id}:${snapshot.id}`;
  if(task.status==='completed' && task.completed_at===attempt){
   if((await getTaskEvents(db,task.id)).some(e=>e.note?.includes(marker)))continue;
  }else{
   const {canCloseAdTasks}=await import('@aula-agente/shared');
   if(!canCloseAdTasks([task],[snapshot]))continue;
   const {data:changed,error:writeError}=await db.from('tasks').update({status:'completed',completed_at:attempt,consolidated_pendencies:[]}).eq('organization_id',orgId).eq('id',snapshot.id).eq('updated_at',snapshot.updated_at).in('status',['pending','in_progress','rescheduled']).select('id').maybeSingle();if(writeError)throw writeError;if(!changed)continue;
  }
  await addTaskEvent(db,{task_id:snapshot.id,organization_id:orgId,event_type:'completed',note:JSON.stringify({marker,source:'scheduled_ad_closure',batch_id:recorded.metadata!.scheduled_ad_closure!.batch_id,message_id:recorded.id,text:recorded.content,evolution_message_id:recorded.evolution_message_id,resolved_pendencies:task.consolidated_pendencies}),created_by_type:'ai',created_by_id:null});
 }
}
