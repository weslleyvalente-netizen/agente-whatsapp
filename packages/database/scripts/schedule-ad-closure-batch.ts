// node --env-file=.env --experimental-strip-types packages/database/scripts/schedule-ad-closure-batch.ts --org UUID --start ISO --end ISO --output /private/tmp/manifest.json
// --apply --manifest FILE --expected-contacts N --expected-tasks N: installs
// the reviewed snapshot only. No messages or task completions at registration.
import {readFile,writeFile} from 'node:fs/promises';
import {getAdminClient,getAdClosureState,getOrganizationById} from '../dist/index.js';
import {isUnengagedAdContact,canCloseAdTasks,buildAdClosureSchedule,validateClosingSettings,type ScheduledAdClosureBatch} from '@aula-agente/shared';
function arg(name:string){const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];}
const db=getAdminClient();
const orgId=arg('--org');if(!orgId)throw new Error('Informe --org.');
const org=await getOrganizationById(db,orgId);
if(process.argv.includes('--apply')){
 const filename=arg('--manifest');if(!filename)throw new Error('Informe o manifesto revisado.');
 const batch:ScheduledAdClosureBatch=JSON.parse(await readFile(filename,'utf8'));
 validateClosingSettings(batch.message,1);
 if(batch.recipients.length!==Number(arg('--expected-contacts')) || batch.recipients.reduce((n,r)=>n+r.tasks.length,0)!==Number(arg('--expected-tasks')))throw new Error('Contagens divergentes.');
 buildAdClosureSchedule(batch.recipients,batch.startAt,batch.endAt,batch.intervalMinutes);
 if(Date.parse(batch.startAt)<=Date.now())throw new Error('O início precisa estar no futuro.');
 if(org.settings.scheduled_ad_closure_batch){if(org.settings.scheduled_ad_closure_batch.id===batch.id){console.log('Fila já registrada; não foi alterada.');process.exit(0);}throw new Error('Já existe uma fila. Revisar antes de substituí-la.');}
 for(const r of batch.recipients){const state=await getAdClosureState(db,orgId,r.contactId);if(!isUnengagedAdContact(state,r.initialMessageId)||!canCloseAdTasks(state.tasks,r.tasks)||!state.conversations.some(c=>c.id===r.conversationId)||!state.messages.some((m:any)=>m.id===r.initialMessageId && m.conversation_id===r.conversationId))throw new Error(`O contato ${r.contactId} mudou. Refazer levantamento.`);}
 const {data,error}=await db.from('organizations').update({settings:{...org.settings,sales_low_intent_closing_message:org.settings.sales_low_intent_closing_message??batch.message,sales_low_intent_final_delay_hours:org.settings.sales_low_intent_final_delay_hours??1,scheduled_ad_closure_batch:batch,scheduled_ad_closure_enabled:true}}).eq('id',orgId).eq('settings',JSON.stringify(org.settings)).select('id').maybeSingle();if(error)throw error;if(!data)throw new Error('As configurações mudaram.');
 console.log(JSON.stringify({registered:true,contacts:batch.recipients.length,tasks:batch.recipients.reduce((n,r)=>n+r.tasks.length,0),start:batch.startAt,end:batch.endAt}));
}else{
 const start=arg('--start'),end=arg('--end'),output=arg('--output');if(!start||!end||!output)throw new Error('Informe --start, --end e --output.');
 let tasks:any[]=[];
 for(let from=0;;from+=500){const {data,error}=await db.from('tasks').select('contact_id').eq('organization_id',orgId).in('status',['pending','in_progress','rescheduled']).order('id').range(from,from+499);if(error)throw error;tasks.push(...(data??[]));if(!data||data.length<500)break;}
 async function all(table:string,select:string,role?:string){const out:any[]=[];for(let from=0;;from+=500){let q=db.from(table).select(select).eq('organization_id',orgId!).order('id').range(from,from+499);if(role)q=q.eq('role',role);const {data,error}=await q;if(error)throw error;out.push(...(data??[]));if(!data||data.length<500)return out;}}
 const [conversations,inbound]=await Promise.all([all('conversations','id,contact_id'),all('messages','id,conversation_id,content','contact')]);
 const contactByConversation=new Map(conversations.map(c=>[c.id,c.contact_id]));const byContact=new Map<string,any[]>();
 for(const m of inbound){const contact=contactByConversation.get(m.conversation_id);if(contact){const list=byContact.get(contact)??[];list.push(m);byContact.set(contact,list);}}
 const candidates:any[]=[],excluded:any[]=[];
 for(const contactId of new Set(tasks.map(t=>t.contact_id))){
  const first=byContact.get(contactId)??[];
  if(first.length!==1 || !first[0].content?.startsWith('[Cliente veio de um anúncio:')){excluded.push({contactId,reason:'fora do perfil inicial'});continue;}
  const state=await getAdClosureState(db,orgId,contactId);
  const initial:any=state.messages.filter(m=>m.role==='contact').sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))[0];
  const open=state.tasks.filter(t=>['pending','in_progress','rescheduled'].includes(t.status));const snapshots=open.map(t=>({id:t.id,updated_at:t.updated_at}));
  if(!initial||!isUnengagedAdContact(state,initial.id)||!canCloseAdTasks(state.tasks,snapshots)||Date.parse(start)-Date.parse(initial.created_at)<86400000){excluded.push({contactId,reason:'fora do perfil conservador'});continue;}
  candidates.push({contactId,conversationId:initial.conversation_id,initialMessageId:initial.id,group:initial.content.includes('LiberaCred')?'liberacred':initial.content.includes('Moro nos EUA')?'exterior':'consorcio',tasks:snapshots,name:state.contact.name});
 }
 const recipients=buildAdClosureSchedule(candidates,start,end).map(({name,...r})=>r);
 const batch:ScheduledAdClosureBatch={id:`ad-closure-${start.slice(0,10)}`,startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),intervalMinutes:15,message:validateClosingSettings(org.settings.sales_low_intent_closing_message,org.settings.sales_low_intent_final_delay_hours).message,recipients};
 await writeFile(output,JSON.stringify(batch,null,2),{mode:0o600});
 console.log(JSON.stringify({dryRun:true,contacts:recipients.length,tasks:recipients.reduce((n,r)=>n+r.tasks.length,0),excluded:excluded.length,groups:candidates.reduce((acc,r)=>(acc[r.group]=(acc[r.group]??0)+1,acc),{}),first:recipients[0]?.scheduledAt,last:recipients.at(-1)?.scheduledAt,manifest:output}));
}
