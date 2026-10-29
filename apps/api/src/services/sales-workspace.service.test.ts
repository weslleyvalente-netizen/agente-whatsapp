import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichSalesWorkspace, resetSalesWorkspaceCacheForTests } from "./sales-workspace.service.js";
beforeEach(() => resetSalesWorkspaceCacheForTests());
const rows = [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01" }];
function database(tables: Record<string, unknown[]>) {
 const scopes: unknown[][] = [];
 const selections: unknown[][] = [];
 const db = { from: (table: string) => {
  const q: any = { select: (fields: string) => { selections.push([table,fields]); return q; }, eq: (...args: unknown[]) => { scopes.push([table, ...args]); return q; }, in: () => q, is: (...args: unknown[]) => { scopes.push([table, 'is', ...args]); return q; }, order: () => q, limit: () => q,
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

describe("lead distribution with the workspace flags off", () => {
  it("ainda esconde o lead de outro vendedor e mantém legado/sem dono", async () => {
    const { db } = database({
      sales_reps: [{ id: "r1", user_id: "marina-user", display_name: "Marina" }, { id: "r2", user_id: "marcio-user", display_name: "Márcio" }],
      lead_assignments: [],
    });
    const r = [
      { id: "a", contact_id: "c1", status: "open", created_at: "2026-10-01", owner_id: "marcio-user" },
      { id: "b", contact_id: "c2", status: "open", created_at: "2026-10-01", owner_id: null },
      { id: "c", contact_id: "c3", status: "open", created_at: "2026-10-01", owner_id: "legado" },
    ];
    const out = await enrichSalesWorkspace(db as any, "org", r as any, false, { enabled: true, viewer: { mode: "own", userId: "marina-user" } });
    expect(out.map((o: any) => o.id)).toEqual(["b", "c"]);
    expect(out[0]).toMatchObject({ lead_assignment: null });
    expect((out[0] as any).sales_state).toBeUndefined();
  });
});

it('ignores after-hours AI replies when deriving the latest message (customer still shows as having written overnight)',async()=>{
 const {db,scopes}=database({conversations:[contactWaiting]});
 await enrichSalesWorkspace(db as any,'org',rows as any,true);
 expect(scopes).toContainEqual(['conversations','is','messages.metadata->>after_hours_pending',null]);
});

// Banco falso que respeita .in("contact_id", ...) e conta as consultas por tabela.
function filteringDb(tables: Record<string, any[]>) {
 const calls: Array<{ table: string; contactIds?: string[] }> = [];
 const db = { from: (table: string) => {
  let ids: string[] | undefined;
  const q: any = { select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q,
   in: (column: string, values: string[]) => { if (column === "contact_id") ids = values; return q; },
   range: (start: number, end: number) => {
    if (start === 0) calls.push({ table, contactIds: ids });
    const data = (tables[table] ?? []).filter(r => !ids || ids.includes(r.contact_id));
    return Promise.resolve({ data: data.slice(start, end + 1), error: null });
   } };
  return q;
 } };
 return { db, calls };
}
const openRows = [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01" }];
const mensagem = { role: "contact", content: "Quero a proposta agora", created_at: "2026-10-04T14:55:00.000Z" };
const conversaDe = (contact_id: string, id = `v-${contact_id}`) => ({ id, contact_id, last_message_at: "2026-10-04T14:59:00.000Z", is_human_takeover: false, wa_contacts: { ai_disabled: false }, messages: [mensagem] });

describe("conversas só dos contatos com negócio aberto", () => {
 it("conversa de contato sem negócio aberto não altera nenhum card (estado idêntico ao de baixar tudo)", async () => {
  const base = { opportunities: [{ id: "a", contact_id: "c" }], handoff_events: [], tasks: [] };
  const comRuido = filteringDb({ ...base, conversations: [conversaDe("c"), conversaDe("sem-negocio-1"), conversaDe("sem-negocio-2")] });
  const semRuido = filteringDb({ ...base, conversations: [conversaDe("c")] });
  vi.useFakeTimers(); vi.setSystemTime(new Date(responseNow));
  try {
   const a = await enrichSalesWorkspace(comRuido.db as any, "org", openRows as any, true);
   resetSalesWorkspaceCacheForTests();
   const b = await enrichSalesWorkspace(semRuido.db as any, "org", openRows as any, true);
   expect(a).toEqual(b);
   expect(a[0].sales_state?.customerReplied).toBe(true);
   expect(comRuido.calls.filter(c => c.table === "conversations").every(c => c.contactIds?.every(id => id === "c"))).toBe(true);
  } finally { vi.useRealTimers(); }
 });
 it("busca em lotes de 100 ids", async () => {
  const opportunities = Array.from({ length: 250 }, (_, i) => ({ id: `o${i}`, contact_id: `c${i}` }));
  const { db, calls } = filteringDb({ opportunities, conversations: opportunities.map(o => conversaDe(o.contact_id)), handoff_events: [], tasks: [] });
  await enrichSalesWorkspace(db as any, "org", opportunities.map(o => ({ ...o, status: "open", created_at: "2026-10-01" })) as any, true);
  expect(calls.filter(c => c.table === "conversations").map(c => c.contactIds?.length).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([50, 100, 100]);
 });
 it("negócio fechado fora do conjunto aberto ainda recebe a própria conversa", async () => {
  const { db } = filteringDb({ opportunities: [], conversations: [conversaDe("fechado")], handoff_events: [], tasks: [] });
  vi.useFakeTimers(); vi.setSystemTime(new Date(responseNow));
  try {
   const out = await enrichSalesWorkspace(db as any, "org", [{ id: "x", contact_id: "fechado", status: "won", created_at: "2026-10-01" }] as any, true);
   expect(out[0].sales_state?.customerReplied).toBe(true);
  } finally { vi.useRealTimers(); }
 });
});

describe("cache dos insumos da organização", () => {
 const tabelas = () => ({ opportunities: [{ id: "a", contact_id: "c" }], conversations: [conversaDe("c")], handoff_events: [], tasks: [] });
 const leituras = (calls: Array<{ table: string }>) => calls.length;
 it("segunda chamada dentro de 20 s não volta ao banco e expira depois", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(responseNow));
  try {
   const { db, calls } = filteringDb(tabelas());
   await enrichSalesWorkspace(db as any, "org", openRows as any, true);
   const primeira = leituras(calls);
   await enrichSalesWorkspace(db as any, "org", openRows as any, true);
   expect(leituras(calls)).toBe(primeira);
   vi.advanceTimersByTime(20_001);
   await enrichSalesWorkspace(db as any, "org", openRows as any, true);
   expect(leituras(calls)).toBe(primeira * 2);
  } finally { vi.useRealTimers(); }
 });
 it("chamadas simultâneas compartilham uma única leitura", async () => {
  const { db, calls } = filteringDb(tabelas());
  await Promise.all([1, 2, 3].map(() => enrichSalesWorkspace(db as any, "org", openRows as any, true)));
  expect(calls.filter(c => c.table === "tasks")).toHaveLength(1);
  expect(calls.filter(c => c.table === "handoff_events")).toHaveLength(1);
 });
 it("não vaza dados entre organizações", async () => {
  const a = filteringDb(tabelas()); const b = filteringDb({ opportunities: [{ id: "a", contact_id: "c" }], conversations: [], handoff_events: [], tasks: [{ id: "t", opportunity_id: "a", contact_id: "c" }] });
  const ra = await enrichSalesWorkspace(a.db as any, "org-a", openRows as any, true);
  const rb = await enrichSalesWorkspace(b.db as any, "org-b", openRows as any, true);
  expect(ra[0].sales_state?.taskCount).toBe(0); expect(rb[0].sales_state?.taskCount).toBe(1);
 });
 it("erro de leitura não fica em cache", async () => {
  const ruim: any = { from: () => { const q: any = { select: () => q, eq: () => q, in: () => q, is: () => q, order: () => q, limit: () => q, range: () => Promise.resolve({ data: null, error: new Error("queda") }) }; return q; } };
  await expect(enrichSalesWorkspace(ruim, "org", openRows as any, true)).rejects.toThrow("queda");
  const { db } = filteringDb(tabelas());
  await expect(enrichSalesWorkspace(db as any, "org", openRows as any, true)).resolves.toHaveLength(1);
 });
 it("cada usuário recebe o resultado calculado para si com os mesmos insumos em cache", async () => {
  const { db, calls } = filteringDb({ ...tabelas(), sales_reps: [{ id: "r1", user_id: "marina" }, { id: "r2", user_id: "marcio" }], lead_assignments: [] });
  const linhas = [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01", owner_id: "marcio" }];
  const gerente = await enrichSalesWorkspace(db as any, "org", linhas as any, true, { enabled: true, viewer: { mode: "all" } });
  const marina = await enrichSalesWorkspace(db as any, "org", linhas as any, true, { enabled: true, viewer: { mode: "own", userId: "marina" } });
  const marcio = await enrichSalesWorkspace(db as any, "org", linhas as any, true, { enabled: true, viewer: { mode: "own", userId: "marcio" } });
  expect([gerente.length, marina.length, marcio.length]).toEqual([1, 0, 1]);
  expect(calls.filter(c => c.table === "sales_reps")).toHaveLength(1);
 });
});

describe("tarefas sem negócio aberto com conversas só dos contatos das tarefas", () => {
 it("mantém o resultado e busca só as conversas dos contatos órfãos, com cache", async () => {
  const { getSalesTasksWithoutOpenBusiness } = await import("./sales-workspace.service.js");
  const { db, calls } = filteringDb({
   opportunities: [{ id: "a", contact_id: "linked" }],
   tasks: [{ id: "one", opportunity_id: null, contact_id: "orphan", type: "other", due_date: "2026-10-02", created_at: "2026-10-01", status: "pending" }, { id: "two", opportunity_id: null, contact_id: "linked" }],
   conversations: [conversaDe("orphan"), conversaDe("linked"), conversaDe("ruido")],
  });
  const first = await getSalesTasksWithoutOpenBusiness(db as any, "org");
  expect(first.map(t => t.id)).toEqual(["one"]);
  const buscas = calls.filter(c => c.table === "conversations").map(c => c.contactIds);
  expect(buscas).toContainEqual(["orphan"]);
  expect(buscas.flat()).not.toContain("ruido");
  const n = calls.length;
  await getSalesTasksWithoutOpenBusiness(db as any, "org");
  expect(calls.length).toBe(n);
 });
});

describe("invalidação do cache em escritas", () => {
 it.each(["POST", "PUT", "PATCH", "DELETE"])("%s invalida mesmo com erro parcial 500", async method => {
  const { invalidateSalesWorkspaceCacheOnWrite } = await import("./sales-workspace.service.js");
  const { db, calls } = filteringDb({ opportunities: [{ id: "a", contact_id: "c" }], conversations: [conversaDe("c")], handoff_events: [], tasks: [] });
  await enrichSalesWorkspace(db as any, "org", openRows as any, true); const n = calls.length;
  invalidateSalesWorkspaceCacheOnWrite({ method, params: { organizationId: "org" } }, 500);
  await enrichSalesWorkspace(db as any, "org", openRows as any, true);
  expect(calls.length).toBeGreaterThan(n);
 });
 const tabelas = () => ({ opportunities: [{ id: "a", contact_id: "c" }], conversations: [conversaDe("c")], handoff_events: [], tasks: [] });
 async function leituras(escrita?: (m: typeof import("./sales-workspace.service.js")) => void) {
  const mod = await import("./sales-workspace.service.js");
  const { db, calls } = filteringDb(tabelas());
  await mod.enrichSalesWorkspace(db as any, "org", openRows as any, true);
  const antes = calls.length; escrita?.(mod);
  await mod.enrichSalesWorkspace(db as any, "org", openRows as any, true);
  return calls.length - antes;
 }
 const user = { memberships: [{ organization_id: "org" }, { organization_id: "outra" }] };
 it("sem escrita o cache continua valendo", async () => { expect(await leituras()).toBe(0); });
 it("POST/PATCH com organizationId invalida a organização", async () => {
  expect(await leituras(m => m.invalidateSalesWorkspaceCacheOnWrite({ method: "POST", params: { organizationId: "org" }, user }, 201))).toBeGreaterThan(0);
  expect(await leituras(m => m.invalidateSalesWorkspaceCacheOnWrite({ method: "PATCH", params: { organizationId: "org" }, user }, 200))).toBeGreaterThan(0);
 });
 it("escrita sem organizationId invalida todas as organizações do usuário", async () => {
  expect(await leituras(m => m.invalidateSalesWorkspaceCacheOnWrite({ method: "POST", params: { id: "x" }, user }, 200))).toBeGreaterThan(0);
 });
 it("escrita de outra organização não invalida esta", async () => {
  expect(await leituras(m => m.invalidateSalesWorkspaceCacheOnWrite({ method: "POST", params: { organizationId: "outra" }, user }, 200))).toBe(0);
 });
 it.each(["GET", "HEAD", "OPTIONS"])("%s não invalida", async method => {
  expect(await leituras(m => m.invalidateSalesWorkspaceCacheOnWrite({ method, params: { organizationId: "org" }, user }, 200))).toBe(0);
 });
 it.each([401, 403, 404])("resposta %i não invalida", async status => {
  expect(await leituras(m => m.invalidateSalesWorkspaceCacheOnWrite({ method: "POST", params: { organizationId: "org" }, user }, status))).toBe(0);
 });
 it("requisição sem usuário e sem organização (webhook) não invalida", async () => {
  expect(await leituras(m => m.invalidateSalesWorkspaceCacheOnWrite({ method: "POST", params: {} }, 200))).toBe(0);
 });
});

describe("negócios abertos fora do cache e pendências sem negócio", () => {
 it("card novo (fora do cache) conta como aberto e segundo negócio aberto dá contagem 2", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(responseNow));
  try {
   const { db } = filteringDb({ opportunities: [{ id: "a", contact_id: "c" }], conversations: [conversaDe("c"), conversaDe("novo")], handoff_events: [{ conversation_id: "v-novo", motivo: "proposta_pronta", resumo: "Quer aderir", handed_at: "2026-10-04T14:58:00.000Z", first_human_reply_at: null }], tasks: [] });
   await enrichSalesWorkspace(db as any, "org", openRows as any, true); // aquece o cache só com "c"
   const novo = { id: "n", contact_id: "novo", status: "open", created_at: "2026-10-04" };
   const out = await enrichSalesWorkspace(db as any, "org", [...openRows, novo, { id: "n2", contact_id: "c", status: "open", created_at: "2026-10-04" }] as any, true);
   expect(out[1].sales_state).toMatchObject({ readyForHuman: true, customerReplied: true });
   // "c" agora tem 2 negócios abertos (a do cache + n2): ambíguo, não vira pronto para humano
   expect(out[0].sales_state?.readyForHuman).toBe(false);
  } finally { vi.useRealTimers(); }
 });
 it("negócio fechado na resposta sai da contagem mesmo que o cache o traga como aberto", async () => {
  const { db } = filteringDb({ opportunities: [{ id: "a", contact_id: "c" }, { id: "b", contact_id: "c" }], conversations: [conversaDe("c")], handoff_events: [{ conversation_id: "v-c", motivo: "proposta_pronta", resumo: "x", handed_at: "2026-10-04T14:58:00.000Z", first_human_reply_at: null }], tasks: [] });
  const out = await enrichSalesWorkspace(db as any, "org", [{ id: "a", contact_id: "c", status: "open", created_at: "x" }, { id: "b", contact_id: "c", status: "won", created_at: "x" }] as any, true);
  expect(out[0].sales_state?.readyForHuman).toBe(true);
 });
 it("pendências sem negócio leem os negócios abertos direto, não do cache do workspace", async () => {
  const { getSalesTasksWithoutOpenBusiness } = await import("./sales-workspace.service.js");
  const antigo = filteringDb({ opportunities: [], conversations: [], handoff_events: [], tasks: [] });
  await enrichSalesWorkspace(antigo.db as any, "org", [{ id: "z", contact_id: "z", status: "open", created_at: "x" }] as any, true); // cache sem o negócio de "linked"
  const { db } = filteringDb({ opportunities: [{ id: "a", contact_id: "linked" }], tasks: [{ id: "two", opportunity_id: null, contact_id: "linked", type: "other", due_date: "2026-10-02", created_at: "2026-10-01", status: "pending" }], conversations: [] });
  expect(await getSalesTasksWithoutOpenBusiness(db as any, "org")).toEqual([]);
 });
});
