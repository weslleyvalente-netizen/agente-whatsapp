/** Read-only. Run from repository root with node --env-file=.env --experimental-strip-types. */
import {getAdminClient,getQualificationByConversationId} from '../dist/index.js';
import {decideSalesPipeline} from '../../shared/src/sales-pipeline-policy.ts';
if(process.argv.includes('--apply'))throw new Error('Aplicação em lote exige aprovação das contagens; este comando é somente leitura.');
const organizationId=process.argv.find(x=>x.startsWith('--organization='))?.split('=')[1];
if(!organizationId)throw new Error('Informe --organization=<id>');
const db=getAdminClient();
async function all(query:()=>any){const rows:any[]=[];for(let offset=0;;offset+=500){const {data,error}=await query().range(offset,offset+499);if(error)throw error;rows.push(...data??[]);if((data??[]).length<500)return rows;}}
const [tasks,opps]=await Promise.all([all(()=>db.from('tasks').select('id,contact_id,conversation_id').eq('organization_id',organizationId).in('status',['pending','in_progress','rescheduled']).order('id')),all(()=>db.from('opportunities').select('contact_id').eq('organization_id',organizationId).order('id'))]);
const known=new Set(opps.map(o=>o.contact_id));const orphans=tasks.filter(t=>!known.has(t.contact_id));const contacts=[...new Set(orphans.map(t=>t.contact_id))];
const counts={contacts:contacts.length,tasks:orphans.length,candidates:0,ambiguousOrUnknown:0,noCustomerContext:0};
const candidates:any[]=[];
for(const contactId of contacts){
 const {data:c,error:ce}=await db.from('conversations').select('id').eq('organization_id',organizationId).eq('contact_id',contactId).order('last_message_at',{ascending:false}).limit(1).maybeSingle();if(ce)throw ce;
 if(!c){counts.noCustomerContext++;continue;}
 const [qualification,result]=await Promise.all([getQualificationByConversationId(db,c.id),db.from('messages').select('id,content,created_at').eq('organization_id',organizationId).eq('conversation_id',c.id).eq('role','contact').order('created_at',{ascending:false}).limit(1).maybeSingle()]);if(result.error)throw result.error;
 if(!result.data){counts.noCustomerContext++;continue;}
 const decision=decideSalesPipeline({customerText:result.data.content,qualification:qualification as any});
 if(!decision){counts.ambiguousOrUnknown++;continue;}
 counts.candidates++;candidates.push({contactId,conversationId:c.id,messageId:result.data.id,operation:decision.operation,stage:decision.stage,explicit:decision.explicitOperation});
}
console.log(JSON.stringify({dryRun:true,counts,candidates},null,2));
