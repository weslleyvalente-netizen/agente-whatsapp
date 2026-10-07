import { describe, expect, it, vi } from "vitest";
import { enrichSalesWorkspace } from "./sales-workspace.service.js";
const rows = [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01" }];
function database(tables: Record<string, unknown[]>) {
 const scopes: unknown[][] = [];
 const selections: unknown[][] = [];
 const db = { from: (table: string) => {
  const q: any = { select: (fields: string) => { selections.push([table,fields]); return q; }, eq: (...args: unknown[]) => { scopes.push([table, ...args]); return q; }, in: () => q, is: () => q, order: () => q, limit: () => q,
   range: (start: number, end: number) => Promise.resolve({ data: (tables[table] ?? (table === "opportunities" ? rows : [])).slice(start,end+1), error: null }) };
  return q;
 } };
 return { db, scopes, selections };
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


const responseNow = '2026-10-04T15:00:00.000Z';
const contactWaiting = {id:'v',contact_id:'c',last_message_at:'2026-10-04T14:59:00.000Z',is_human_takeover:false,wa_contacts:{ai_disabled:false},messages:[{role:'contact',created_at:'2026-10-04T14:55:00.000Z'}]};
it('derives responseOverdue from the latest message timestamp and reads AI controls',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(responseNow));
 try {
  const {db,selections}=database({conversations:[contactWaiting]});
  const result=await enrichSalesWorkspace(db as any,'org',rows as any,true);
  expect(result[0].sales_state).toMatchObject({responseOverdue:true,customerReplied:true});
  expect(selections).toContainEqual(['conversations','id,contact_id,last_message_at,is_human_takeover,wa_contacts(ai_disabled),messages(role,content,created_at)']);
 } finally {vi.useRealTimers()}
});
it.each([
 ['human takeover',{...contactWaiting,is_human_takeover:true},{}],
 ['disabled AI',{...contactWaiting,wa_contacts:{ai_disabled:true}},{}],
 ['disabled AI in an array relation',{...contactWaiting,wa_contacts:[{ai_disabled:true}]},{}],
 ['recent contact message',{...contactWaiting,last_message_at:'2026-10-04T14:50:00.000Z',messages:[{role:'contact',created_at:'2026-10-04T14:59:00.000Z'}]},{}],
 ['agent reply',{...contactWaiting,messages:[{role:'agent',created_at:'2026-10-04T14:50:00.000Z'}]},{}],
 ['missing timestamp',{...contactWaiting,messages:[{role:'contact'}]},{}],
 ['closed business',contactWaiting,{status:'won'}],
 ['lost business',contactWaiting,{status:'lost'}],
 ['frozen business',contactWaiting,{frozen_until:'2026-10-05'}],
 ['expired freeze',contactWaiting,{frozen_until:'2026-10-03'}],
] as const)('suppresses overdue for %s',async(_label,conversation,overrides)=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(responseNow));
 try {
  const {db}=database({conversations:[conversation]});
  const result=await enrichSalesWorkspace(db as any,'org',[{...rows[0],...overrides}] as any,true);
  expect(result[0].sales_state?.responseOverdue).toBe(false);
 } finally {vi.useRealTimers()}
});
it('suppresses overdue while a request_human is pending',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(responseNow));
 try {
  const {db}=database({conversations:[contactWaiting],handoff_events:[{conversation_id:'v',motivo:'cliente_pediu',resumo:null,first_human_reply_at:null}]});
  const result=await enrichSalesWorkspace(db as any,'org',rows as any,true);
  expect(result[0].sales_state).toMatchObject({responseOverdue:false,humanPending:true});
 } finally {vi.useRealTimers()}
});
it('uses the newest conversation for the contact',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(responseNow));
 try {
  const {db}=database({conversations:[{...contactWaiting,last_message_at:'2026-10-04T14:55:00.000Z'},{...contactWaiting,id:'new',last_message_at:'2026-10-04T14:59:00.000Z',messages:[{role:'agent',created_at:'2026-10-04T14:59:00.000Z'}]}]});
  const result=await enrichSalesWorkspace(db as any,'org',rows as any,true);
  expect(result[0].sales_state).toMatchObject({responseOverdue:false,customerReplied:false});
 } finally {vi.useRealTimers()}
});
it('does not flag a courtesy-only customer message as a reply to answer',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(responseNow));
 try {
  const {db}=database({conversations:[{...contactWaiting,messages:[{role:'contact',content:'Obrigado!',created_at:'2026-10-04T14:55:00.000Z'}]}]} as any);
  const result=await enrichSalesWorkspace(db as any,'org',rows as any,true);
  expect(result[0].sales_state).toMatchObject({customerReplied:false});
 } finally {vi.useRealTimers()}
});

describe("lead distribution on cards", () => {
  it("anexa a atribuição ativa e esconde o lead que pertence a outro vendedor", async () => {
    const { db } = database({
      conversations: [], handoff_events: [], tasks: [],
      opportunities: [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01", owner_id: "marcio-user" }],
      sales_reps: [{ id: "r1", user_id: "marina-user", display_name: "Marina" }, { id: "r2", user_id: "marcio-user", display_name: "Márcio" }],
      lead_assignments: [{ id: "x", contact_id: "c", rep_id: "r2", status: "pending", sla_due_at: "2026-10-05T12:15:00Z", assigned_at: "2026-10-05T12:00:00Z", accepted_at: null }],
    });
    const rows = [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01", owner_id: "marcio-user" }];
    const asManager = await enrichSalesWorkspace(db as any, "org", rows as any, true, { enabled: true, viewer: { mode: "all" } });
    expect(asManager[0]).toMatchObject({ lead_assignment: { id: "x", rep_name: "Márcio", status: "pending" } });
    const asMarina = await enrichSalesWorkspace(db as any, "org", rows as any, true, { enabled: true, viewer: { mode: "own", userId: "marina-user" } });
    expect(asMarina).toEqual([]);
    const off = await enrichSalesWorkspace(db as any, "org", rows as any, true);
    expect(off).toHaveLength(1); // sem o parâmetro (flag desligada) nada muda
  });
});
