import { getAdminClient } from "@aula-agente/database";
import { classifySalesCard, classifySalesQueue, sortSalesQueue, type Opportunity, type SalesCardState } from "@aula-agente/shared";

// Every query is organization-scoped; pagination avoids PostgREST's default row cap.
async function readAll(query: () => any): Promise<any[]> {
 const rows: any[] = [];
 for (let start = 0; ; start += 500) {
  const { data, error } = await query().range(start, start + 499);
  if (error) throw error;
  rows.push(...(data ?? []));
  if (!data || data.length < 500) return rows;
 }
}
export async function enrichSalesWorkspace<T extends Opportunity>(db: ReturnType<typeof getAdminClient>, organizationId: string, rows: T[], enabled: boolean): Promise<Array<T & {sales_state?: SalesCardState}>> {
 if (!enabled || !rows.length) return rows;
 const [conversations, handoffs, tasks, openBusinesses] = await Promise.all([
  readAll(() => db.from("conversations").select("id,contact_id,last_message_at,is_human_takeover,wa_contacts(ai_disabled),messages(role,created_at)").eq("organization_id", organizationId).in("status", ["open", "waiting"]).order("id").order("created_at", {ascending:false, referencedTable:"messages"}).limit(1,{referencedTable:"messages"})),
  readAll(() => db.from("handoff_events").select("conversation_id,motivo,resumo,handed_at,first_human_reply_at").eq("organization_id",organizationId).eq("trigger_type","request_human").is("first_human_reply_at",null).order("handed_at",{ascending:false}).order("id")),
  readAll(() => db.from("tasks").select("id,opportunity_id,contact_id,type,due_date,priority,consolidated_pendencies").eq("organization_id",organizationId).in("status",["pending","in_progress","rescheduled"]).order("id")),
  readAll(() => db.from("opportunities").select("contact_id").eq("organization_id",organizationId).eq("status","open").order("id")),
 ]);
 const latest = new Map<string, any>();
 for (const c of conversations) if (!latest.has(c.contact_id) || (c.last_message_at ?? "") > (latest.get(c.contact_id).last_message_at ?? "")) latest.set(c.contact_id,c);
 const pending = new Map<string, any>();
 for (const h of handoffs) if (!pending.has(h.conversation_id)) pending.set(h.conversation_id,h);
 const counts = new Map<string,number>(); const taskCounts = new Map<string,number>(); const contactTaskCounts = new Map<string,number>();
 for (const o of openBusinesses) counts.set(o.contact_id,(counts.get(o.contact_id) ?? 0)+1);
 for (const t of tasks) {
  if (t.opportunity_id) taskCounts.set(t.opportunity_id,(taskCounts.get(t.opportunity_id) ?? 0)+1);
  else if (t.contact_id) contactTaskCounts.set(t.contact_id,(contactTaskCounts.get(t.contact_id) ?? 0)+1);
 }
 const now = new Date().toISOString();
 return rows.map(o => {
  const c = latest.get(o.contact_id); const h = o.status === "open" ? pending.get(c?.id) ?? null : null;
  const contact = Array.isArray(c?.wa_contacts) ? c.wa_contacts[0] : c?.wa_contacts;
  return {...o,sales_state:{...classifySalesCard({openOpportunityCount:counts.get(o.contact_id) ?? 0,handoff:h,latestRole:c?.messages?.[0]?.role ?? null,latestMessageAt:c?.messages?.[0]?.created_at ?? null,isHumanTakeover:c?.is_human_takeover,aiDisabled:contact?.ai_disabled,status:o.status,frozenUntil:o.frozen_until,taskCount:(taskCounts.get(o.id) ?? 0) + (contactTaskCounts.get(o.contact_id) ?? 0)},now),handoffSummary:h?.resumo ?? null,handedAt:h?.handed_at ?? null,tasks:tasks.filter(t=>t.opportunity_id===o.id || !t.opportunity_id && t.contact_id===o.contact_id).map(t=>({id:t.id,type:t.type,due_date:t.due_date,priority:t.priority,consolidated_pendencies:(t.consolidated_pendencies??[]).map((p:any)=>({type:p.type,due_date:p.due_date,priority:p.priority}))}))}};
 });
}

/** Old tasks without an open business stay accessible without historical writes. */
export async function getSalesTasksWithoutOpenBusiness(db:ReturnType<typeof getAdminClient>,organizationId:string){
 const [tasks,businesses,conversations]=await Promise.all([
  readAll(()=>db.from('tasks').select('*,wa_contacts(name,phone)').eq('organization_id',organizationId).in('status',['pending','in_progress','rescheduled']).order('due_date').order('id')),
  readAll(()=>db.from('opportunities').select('id,contact_id').eq('organization_id',organizationId).eq('status','open').order('id')),
  readAll(()=>db.from('conversations').select('contact_id,last_message_at,messages(role,created_at)').eq('organization_id',organizationId).in('status',['open','waiting']).order('id').order('created_at',{ascending:false,referencedTable:'messages'}).limit(1,{referencedTable:'messages'}))
 ]);
 const ids=new Set(businesses.map(o=>o.id));const contacts=new Set(businesses.map(o=>o.contact_id));
 const latest=new Map<string,any>();for(const c of conversations)if(!latest.has(c.contact_id)||(c.last_message_at??'')>(latest.get(c.contact_id).last_message_at??''))latest.set(c.contact_id,c);
 const now=new Date().toISOString();
 const candidates=tasks.filter(t=>t.opportunity_id?!ids.has(t.opportunity_id):!contacts.has(t.contact_id)).map(t=>{
  const input={...t,status:'open',stage:'qualification',waiting_on:['awaiting_customer_cpf','awaiting_customer_data'].includes(t.type)?'customer':null,next_action_due_date:null,tasks:[t],sales_state:{readyForHuman:false,humanPending:false,taskCount:1,customerReplied:latest.get(t.contact_id)?.messages?.[0]?.role==='contact'}};
  return {...input,queue_group:classifySalesQueue(input,now).group,original_status:t.status};
 });
 return sortSalesQueue(candidates,now).map(({tasks,sales_state,original_status,...t})=>({...t,status:original_status}));
}
