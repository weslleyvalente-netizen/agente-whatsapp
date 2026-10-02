import { describe, expect, it, vi } from "vitest";
import { enrichSalesWorkspace } from "./sales-workspace.service.js";
const rows = [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01" }];
function database(tables: Record<string, unknown[]>) {
 const scopes: unknown[][] = [];
 const db = { from: (table: string) => {
  const q: any = { select: () => q, eq: (...args: unknown[]) => { scopes.push([table, ...args]); return q; }, in: () => q, is: () => q, order: () => q, limit: () => q,
   range: (start: number, end: number) => Promise.resolve({ data: (tables[table] ?? (table === "opportunities" ? rows : [])).slice(start,end+1), error: null }) };
  return q;
 } };
 return { db, scopes };
}
describe("sales workspace enrichment", () => {
 it("does no operational reads when disabled", async () => {
  const db = { from: vi.fn() }; expect(await enrichSalesWorkspace(db as any, "org", rows as any, false)).toEqual(rows); expect(db.from).not.toHaveBeenCalled();
 });
 it("joins tasks and pending handoffs scoped to the organization", async () => {
  const {db,scopes} = database({ conversations: [{id:"v",contact_id:"c",last_message_at:"2026-10-01",messages:[{role:"contact"}]}], handoff_events:[{conversation_id:"v",motivo:"proposta_pronta",resumo:"Quer aderir",handed_at:"2026-10-01",first_human_reply_at:null}], tasks:[{opportunity_id:"a"}] });
  const result = await enrichSalesWorkspace(db as any,"org",rows as any,true);
  expect(result[0]).toMatchObject({ sales_state: { readyForHuman:true, hot:true, taskCount:1, customerReplied:true, handoffSummary:"Quer aderir" } });
  for (const table of ["conversations","handoff_events","tasks"]) expect(scopes).toContainEqual([table,"organization_id","org"]);
 });
 it("does not move ambiguous contacts or lost businesses", async () => {
  const {db} = database({opportunities:[...rows,{...rows[0],id:"b"}],conversations:[{id:"v",contact_id:"c",last_message_at:"2026-10-01",messages:[]}],handoff_events:[{conversation_id:"v",motivo:"proposta_pronta",resumo:"Quer aderir",first_human_reply_at:null}],tasks:[]});
  const result = await enrichSalesWorkspace(db as any,"org",[...rows,{...rows[0],id:"b"},{...rows[0],id:"lost",status:"lost"}] as any,true);
  expect(result[0].sales_state?.readyForHuman).toBe(false); expect(result[2].sales_state?.humanPending).toBe(false);
 });
});

it("counts contact-only tasks without counting another business's task",async()=>{
 const {db}=database({tasks:[{opportunity_id:null,contact_id:"c"},{opportunity_id:"another",contact_id:"c"}],conversations:[],handoff_events:[]});
 const result=await enrichSalesWorkspace(db as any,"org",rows as any,true);expect(result[0].sales_state?.taskCount).toBe(1);
});

it('includes task priority and due dates for the operational queue',async()=>{
 const {db}=database({tasks:[{id:'task',opportunity_id:'a',contact_id:'c',type:'run_quote',due_date:'2026-10-02',priority:'urgent'}],conversations:[],handoff_events:[]});
 const result=await enrichSalesWorkspace(db as any,'org',rows as any,true);
 expect(result[0].sales_state).toMatchObject({tasks:[{id:'task',type:'run_quote',priority:'urgent',due_date:'2026-10-02'}]});
});

it('keeps only tasks without an open business in the historical review queue',async()=>{
 const {getSalesTasksWithoutOpenBusiness}=await import('./sales-workspace.service.js');
 const {db}=database({opportunities:[{id:'a',contact_id:'linked'}],tasks:[{id:'one',opportunity_id:null,contact_id:'orphan',type:'other',due_date:'2026-10-02',created_at:'2026-10-01',status:'pending'},{id:'two',opportunity_id:null,contact_id:'linked'},{id:'three',opportunity_id:'closed',contact_id:'other',type:'other',due_date:'2026-10-02',created_at:'2026-10-01',status:'pending'}]});
 expect((await getSalesTasksWithoutOpenBusiness(db as any,'org')).map(t=>t.id)).toEqual(['one','three']);
});
