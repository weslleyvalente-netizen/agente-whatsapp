import { getAdminClient } from "@aula-agente/database";
import { classifySalesCard, type Opportunity, type SalesCardState } from "@aula-agente/shared";

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
  readAll(() => db.from("conversations").select("id,contact_id,last_message_at,messages(role,created_at)").eq("organization_id", organizationId).in("status", ["open", "waiting"]).order("id").order("created_at", {ascending:false, referencedTable:"messages"}).limit(1,{referencedTable:"messages"})),
  readAll(() => db.from("handoff_events").select("conversation_id,motivo,resumo,handed_at,first_human_reply_at").eq("organization_id",organizationId).eq("trigger_type","request_human").is("first_human_reply_at",null).order("handed_at",{ascending:false}).order("id")),
  readAll(() => db.from("tasks").select("opportunity_id,contact_id").eq("organization_id",organizationId).in("status",["pending","in_progress","rescheduled"]).order("id")),
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
 return rows.map(o => {
  const c = latest.get(o.contact_id); const h = o.status === "open" ? pending.get(c?.id) ?? null : null;
  return {...o,sales_state:{...classifySalesCard({openOpportunityCount:counts.get(o.contact_id) ?? 0,handoff:h,latestRole:c?.messages?.[0]?.role ?? null,taskCount:(taskCounts.get(o.id) ?? 0) + (contactTaskCounts.get(o.contact_id) ?? 0)}),handoffSummary:h?.resumo ?? null,handedAt:h?.handed_at ?? null}};
 });
}
