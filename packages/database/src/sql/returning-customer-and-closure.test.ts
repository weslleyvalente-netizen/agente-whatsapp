// Cliente que volta (card por intenção) + encerramento automático sem resposta: regras de banco.
// Casos reais 24-25/11: Rosângela e Bruno (perdidos "sem resposta" e voltaram sem card), Cleber e Rosival (cadastro @lid duplicado
// ganhou card de pós-venda), conversa 2acaf16c (despedida + perdido feitos à mão).
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_ON, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";


let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => {
  ({ db, q } = await setupHandoffDb());
});

const RC_WRITE = { ...ALL_ON, returning_customer_card_enabled: true, returning_customer_card_mode: "write", no_reply_closure_enabled: true,
  no_reply_closure_started_at: "2026-11-01T00:00:00Z" };

const contact = async (org: string, phone: string | null, metadata: object | null = null) =>
  (await q("insert into public.wa_contacts(organization_id,phone,metadata) values ($1,$2,$3) returning id", [org, phone, metadata && JSON.stringify(metadata)]))[0].id as string;
const conversation = async (org: string, contactId: string, assignedTo: string | null = null) =>
  (await q("insert into public.conversations(organization_id,contact_id,assigned_to,evolution_instance_id) values ($1,$2,$3,gen_random_uuid()) returning id", [org, contactId, assignedTo]))[0].id as string;
const closedOpp = async (org: string, contactId: string, status: "won" | "lost", owner: string | null, operation = "vehicle_sale", lostReason: string | null = "sem_resposta") =>
  (await q("insert into public.opportunities(organization_id,contact_id,status,stage,owner_id,operation,initial_operation,lost_reason) values ($1,$2,$3,'qualification',$4,$5,$5,$6) returning id",
    [org, contactId, status, owner, operation, status === "lost" ? lostReason : null]))[0].id as string;
const decision = async (org: string, contactId: string, conv: string | null, prev: string | null, over: Record<string, unknown> = {}) => {
  const d = { trigger_kind: "handoff", mode: "write", intent: "commercial", identity_status: "resolved", operation: "vehicle_sale", stage: "qualification",
    reason: "Cliente voltou pedindo fotos e valores", outcome: "would_create", ...over };
  return (await q(`insert into public.returning_customer_decisions(organization_id,contact_id,conversation_id,trigger_kind,trigger_id,mode,intent,identity_status,operation,stage,reason,previous_opportunity_id,outcome)
    values ($1,$2,$3,$4,gen_random_uuid(),$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [org, contactId, conv, d.trigger_kind, d.mode, d.intent, d.identity_status, d.operation, d.stage, d.reason, prev, d.outcome]))[0].id as string;
};
const open = async (decisionId: string) => (await q("select public.open_returning_customer_opportunity($1) as id", [decisionId]))[0].id as string | null;

describe("identidade do contato (telefone e @lid)", () => {
  it("agrupa variações do mesmo telefone (55 e nono dígito), @lid unificado e @lid apontado; @lid nunca resolvido fica sozinho", async () => {
    const { org } = await seedWorld(db);
    const real = await contact(org, "5562991234567", { lid: "999@lid" });
    const sem9 = await contact(org, "556291234567");
    const lid = await contact(org, "999@lid");
    const merged = await contact(org, "888@lid#merged", { merged_into: real });
    const outro = await contact(org, "5562990000000");
    const solto = await contact(org, "777@lid");
    const ids = (await q("select public._contact_identity_ids($1,$2) as ids", [org, real]))[0].ids as string[];
    expect(new Set(ids)).toEqual(new Set([real, sem9, lid, merged]));
    expect(ids).not.toContain(outro);
    expect((await q("select public._contact_identity_ids($1,$2) as ids", [org, lid]))[0].ids).toContain(real);
    expect((await q("select public._contact_identity_ids($1,$2) as ids", [org, solto]))[0].ids).toEqual([solto]);
  });

  it("caso Cleber/Rosival: cadastro @lid ligado a cliente com venda NÃO ganha card de encaminhamento; contato novo continua ganhando", async () => {
    const { org, reps } = await seedWorld(db);
    const real = await contact(org, "5562991112222", { lid: "555@lid" });
    await closedOpp(org, real, "won", reps["Marina"].userId);
    const lid = await contact(org, "555@lid");
    const conv = await conversation(org, lid);
    expect((await q("select public._open_opportunity_for_handoff($1,$2,$3,$4) as id", [org, conv, lid, reps["Marina"].userId]))[0].id).toBeNull();
    const novo = await contact(org, "5562993334444");
    const conv2 = await conversation(org, novo);
    expect((await q("select public._open_opportunity_for_handoff($1,$2,$3,$4) as id", [org, conv2, novo, reps["Marina"].userId]))[0].id).not.toBeNull();
  });

  it("tarefa humana de follow-up no cadastro @lid de cliente com histórico não abre negócio", async () => {
    const { org, reps } = await seedWorld(db);
    const real = await contact(org, "5562991112222", { lid: "556@lid" });
    await closedOpp(org, real, "lost", reps["Marina"].userId);
    const lid = await contact(org, "556@lid");
    await q("insert into public.tasks(organization_id,contact_id,assignee_type,assignee_id,type,due_date,created_by_type) values ($1,$2,'human',$3,'vehicle_followup',current_date,'ai')", [org, lid, reps["Marina"].userId]);
    expect(await q("select 1 from public.opportunities where contact_id=$1", [lid])).toHaveLength(0);
  });
});

describe("open_returning_customer_opportunity", () => {
  it("caso Bruno: cria card ligado ao anterior, dona anterior ativa, tarefa comercial vinculada, log com motivo; anterior intacto", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const marina = reps["Marina"].userId;
    const c = await contact(org, "5562997779344", { lead_origin: { source: "meta_ads" } });
    const conv = await conversation(org, c, marina);
    const prev = await closedOpp(org, c, "lost", marina, "financing");
    const task = (await q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,assignee_id,type,due_date,created_by_type) values ($1,$2,$3,'ai',null,'financing_followup',current_date,'ai') returning id", [org, c, conv]))[0].id;
    const adminTask = (await q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,type,due_date,created_by_type) values ($1,$2,$3,'ai','other',current_date,'ai') returning id", [org, c, conv]))[0].id;
    const d = await decision(org, c, conv, prev, { operation: "financing" });
    const id = await open(d);
    expect(id).not.toBeNull();
    const o = (await q("select * from public.opportunities where id=$1", [id]))[0];
    expect(o).toMatchObject({ status: "open", operation: "financing", stage: "qualification", owner_id: marina, previous_opportunity_id: prev });
    expect((await q("select status, lost_reason from public.opportunities where id=$1", [prev]))[0]).toEqual({ status: "lost", lost_reason: "sem_resposta" });
    expect((await q("select opportunity_id from public.tasks where id=$1", [task]))[0].opportunity_id).toBe(id);
    expect((await q("select opportunity_id from public.tasks where id=$1", [adminTask]))[0].opportunity_id).toBeNull();
    const ev = (await q("select * from public.opportunity_events where opportunity_id=$1", [id]))[0];
    expect(ev.new_value).toMatchObject({ source: "returning_customer", previous_opportunity_id: prev, decision_id: d, owner_rule: "previous_owner", lead_origin_historico: { source: "meta_ads" } });
    expect(ev.evidence).toContain("Cliente voltou pedindo fotos e valores");
    expect((await q("select outcome, opportunity_id from public.returning_customer_decisions where id=$1", [d]))[0]).toEqual({ outcome: "created", opportunity_id: id });
    expect(await open(d)).toBe(id); // idempotente
    expect(await q("select 1 from public.opportunities where contact_id=$1 and status='open'", [c])).toHaveLength(1);
  });

  it("dono anterior fora (out): usa o vendedor entregue pelo rodízio na conversa", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    await q("update public.sales_reps set availability='out' where user_id=$1", [reps["Marina"].userId]);
    const c = await contact(org, "5562990001111");
    const conv = await conversation(org, c);
    const h = (await q("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2) returning id", [org, conv]))[0].id;
    await q("insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,assigned_at,handoff_at,sla_due_at,strategy_version) values ($1,gen_random_uuid(),$5,$2,$3,$4,'round_robin','pending',now(),now(),now()+interval '1 hour','v1')",
      [org, c, conv, reps["Márcio"].repId, h]);
    const prev = await closedOpp(org, c, "won", reps["Marina"].userId);
    const id = await open(await decision(org, c, conv, prev));
    expect((await q("select owner_id from public.opportunities where id=$1", [id]))[0].owner_id).toBe(reps["Márcio"].userId);
  });

  it("sem duplicidade: negócio aberto compatível em OUTRO cadastro do mesmo cliente bloqueia; operação diferente pode coexistir", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const real = await contact(org, "5562991112222", { lid: "321@lid" });
    const lid = await contact(org, "321@lid");
    const prev = await closedOpp(org, real, "lost", reps["Marina"].userId);
    await q("insert into public.opportunities(organization_id,contact_id,status,operation,initial_operation) values ($1,$2,'open','vehicle_sale','vehicle_sale')", [org, real]);
    const conv = await conversation(org, lid);
    const d1 = await decision(org, lid, conv, prev);
    expect(await open(d1)).toBeNull();
    expect((await q("select outcome from public.returning_customer_decisions where id=$1", [d1]))[0].outcome).toBe("skipped_open_compatible");
    const d2 = await decision(org, lid, conv, prev, { operation: "consortium", trigger_kind: "task" });
    expect(await open(d2)).not.toBeNull();
  });

  it("eventos simultâneos (encaminhamento + tarefa) do mesmo cliente criam um só card", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const c = await contact(org, "5562994445555");
    const conv = await conversation(org, c);
    const prev = await closedOpp(org, c, "lost", reps["Marina"].userId);
    const a = await decision(org, c, conv, prev);
    const b = await decision(org, c, conv, prev, { trigger_kind: "task" });
    const [x, y] = await Promise.all([open(a), open(b)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(await q("select 1 from public.opportunities where contact_id=$1 and status='open'", [c])).toHaveLength(1);
  });

  it("modo sombra, flag desligada, intenção não comercial ou decisão de revisão nunca criam", async () => {
    const { org, reps } = await seedWorld(db, { ...RC_WRITE, returning_customer_card_mode: "shadow" });
    const c = await contact(org, "5562996667777");
    const conv = await conversation(org, c);
    const prev = await closedOpp(org, c, "lost", reps["Marina"].userId);
    expect(await open(await decision(org, c, conv, prev))).toBeNull();
    await q("update public.organizations set settings = settings || '{\"returning_customer_card_mode\":\"write\"}'::jsonb where id=$1", [org]);
    expect(await open(await decision(org, c, conv, prev, { mode: "shadow" }))).toBeNull();
    expect(await open(await decision(org, c, conv, prev, { intent: "unclear", outcome: "needs_review" }))).toBeNull();
    expect(await open(await decision(org, c, conv, prev, { intent: "administrative", outcome: "skipped_not_commercial" }))).toBeNull();
    await q("update public.organizations set settings = settings || '{\"returning_customer_card_enabled\":false}'::jsonb where id=$1", [org]);
    expect(await open(await decision(org, c, conv, prev))).toBeNull();
    expect(await q("select 1 from public.opportunities where contact_id=$1 and status='open'", [c])).toHaveLength(0);
  });

  it("a mesma origem (gatilho) não gera duas decisões", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const c = await contact(org, "5562996660000");
    const prev = await closedOpp(org, c, "lost", reps["Marina"].userId);
    const trig = (await q("select gen_random_uuid() as id"))[0].id;
    const ins = () => q(`insert into public.returning_customer_decisions(organization_id,contact_id,trigger_kind,trigger_id,mode,intent,identity_status,reason,previous_opportunity_id,outcome)
      values ($1,$2,'handoff',$3,'shadow','unclear','resolved','x',$4,'needs_review') on conflict do nothing returning id`, [org, c, trig, prev]);
    expect(await ins()).toHaveLength(1);
    expect(await ins()).toHaveLength(0);
  });

  it("returning_customer_context: último fechado do grupo, dono ativo e negócios abertos", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const real = await contact(org, "5562991112222", { lid: "654@lid" });
    const lid = await contact(org, "654@lid");
    const prev = await closedOpp(org, real, "lost", reps["Marina"].userId, "financing");
    const ctx = (await q("select public.returning_customer_context($1,$2) as c", [org, lid]))[0].c;
    expect(ctx).toMatchObject({ identity_status: "resolved", open: [], previous: { id: prev, status: "lost", operation: "financing", owner_active: true } });
    const solto = await contact(org, "111@lid");
    expect((await q("select public.returning_customer_context($1,$2) as c", [org, solto]))[0].c).toMatchObject({ identity_status: "unresolved_lid", previous: null });
  });
});

describe("encerramento sem resposta", () => {
  const NOW = new Date("2026-11-25T15:00:00Z"); // 12:00 BRT
  const daysAgo = (d: number, h = 0) => new Date(NOW.getTime() - (d * 24 + h) * 3600_000).toISOString();
  const msg = (org: string, conv: string, role: string, at: string, content = "oi", metadata: object | null = null, evo: string | null = "evo") =>
    q("insert into public.messages(organization_id,conversation_id,role,content,created_at,metadata,evolution_message_id) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [org, conv, role, content, at, metadata && JSON.stringify(metadata), evo]);
  const touch = (conv: string, at: string) => q("update public.conversations set last_message_at=$2 where id=$1", [conv, at]);
  const candidates = async (org: string, wait = 24) =>
    (await q("select * from public.no_reply_closure_candidates($1,$2,$3,50)", [org, NOW.toISOString(), wait])).map((r: any) => r.conversation_id);

  async function silentLead(org: string, followupDays = 3) {
    const c = await contact(org, "556299" + Math.floor(1e7 + Math.random() * 9e7));
    const conv = await conversation(org, c);
    await msg(org, conv, "contact", daysAgo(followupDays + 2), "quero saber o preço");
    await msg(org, conv, "agent", daysAgo(followupDays + 2, -0.1), "Custa R$ 20.900");
    for (let i = followupDays; i >= 1; i--) await msg(org, conv, i % 2 ? "agent" : "human_agent", daysAgo(i), "Ficou alguma dúvida?");
    await touch(conv, daysAgo(1));
    return { c, conv };
  }

  it("3 follow-ups em dias distintos + 24 h de espera = elegível; 2 follow-ups ou espera curta não", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const ok = await silentLead(org, 3);
    const poucos = await silentLead(org, 2);
    expect(await candidates(org)).toEqual([ok.conv]);
    expect(await candidates(org, 30)).toEqual([]); // último envio há 24 h < 30 h
    expect(await candidates(org)).not.toContain(poucos.conv);
  });

  it("várias mensagens no mesmo dia contam 1; envio que falhou não conta", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const { conv } = await silentLead(org, 2);
    await msg(org, conv, "agent", daysAgo(1, 2), "de novo");
    expect(await candidates(org)).toEqual([]);
    await msg(org, conv, "agent", daysAgo(3), "falhou", { send_failed_at: daysAgo(3) });
    expect(await candidates(org)).toEqual([]);
  });

  it("fica de fora: negociação, proposta registrada, retorno marcado, despedida já enviada, IA desligada, cliente respondeu por último", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const neg = await silentLead(org);
    await q("insert into public.opportunities(organization_id,contact_id,status,stage,operation,initial_operation) values ($1,$2,'open','negotiation','vehicle_sale','vehicle_sale')", [org, neg.c]);
    const val = await silentLead(org);
    await q("insert into public.opportunities(organization_id,contact_id,status,stage,operation,initial_operation,sale_amount) values ($1,$2,'open','qualification','vehicle_sale','vehicle_sale',20900)", [org, val.c]);
    const prop = await silentLead(org);
    await q("insert into public.proposal_followups(organization_id,conversation_id,sent_at) values ($1,$2,$3)", [org, prop.conv, daysAgo(2)]);
    const ret = await silentLead(org);
    await q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,type,due_date) values ($1,$2,$3,'human','return_customer',date '2026-11-28')", [org, ret.c, ret.conv]);
    const bye = await silentLead(org);
    await msg(org, bye.conv, "human_agent", daysAgo(1, 1), "Vou encerrar por aqui por enquanto");
    const off = await silentLead(org);
    await q("update public.wa_contacts set ai_disabled=true where id=$1", [off.c]);
    const resp = await silentLead(org);
    await msg(org, resp.conv, "contact", daysAgo(1, -1), "ainda tenho interesse");
    const ok = await silentLead(org);
    expect(await candidates(org)).toEqual([ok.conv]);
  });

  it("apply: só depois do envio confirmado marca perdido 'sem_resposta' com evidência, cancela 'parou de responder' da IA; idempotente", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const { c, conv } = await silentLead(org);
    const opp = (await q("insert into public.opportunities(organization_id,contact_id,status,stage,operation,initial_operation,created_at) values ($1,$2,'open','qualification','vehicle_sale','vehicle_sale',$3) returning id", [org, c, daysAgo(10)]))[0].id;
    const aiTask = (await q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,type,due_date,created_by_type) values ($1,$2,$3,'human','customer_unresponsive',current_date,'ai') returning id", [org, c, conv]))[0].id;
    const sellerTask = (await q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,type,due_date,created_by_type) values ($1,$2,$3,'human','customer_unresponsive',current_date,'human') returning id", [org, c, conv]))[0].id;
    const [pending] = await msg(org, conv, "agent", NOW.toISOString(), "Vou encerrar por aqui", { no_reply_closure: { followup_days: 4, opportunity_id: opp } }, null);
    expect((await q("select public.apply_no_reply_closure($1) as n", [pending.id]))[0].n).toBe(0); // sem confirmação
    expect((await q("select status from public.opportunities where id=$1", [opp]))[0].status).toBe("open");
    await q("update public.messages set evolution_message_id='wamid' where id=$1", [pending.id]);
    expect((await q("select public.apply_no_reply_closure($1) as n", [pending.id]))[0].n).toBe(1);
    expect((await q("select status, lost_reason from public.opportunities where id=$1", [opp]))[0]).toEqual({ status: "lost", lost_reason: "sem_resposta" });
    const ev = (await q("select evidence, changed_by_type from public.opportunity_events where opportunity_id=$1 and event_type='lost'", [opp]))[0];
    expect(ev).toEqual({ evidence: expect.stringMatching(/^Encerramento automático: 3 follow-ups sem resposta \(último em \d\d\/\d\d\)$/), changed_by_type: "ai" });
    expect((await q("select status from public.tasks where id=$1", [aiTask]))[0].status).toBe("cancelled");
    expect((await q("select status from public.tasks where id=$1", [sellerTask]))[0].status).toBe("pending");
    expect((await q("select public.apply_no_reply_closure($1) as n", [pending.id]))[0].n).toBe(0);
    expect(await q("select 1 from public.opportunity_events where opportunity_id=$1 and event_type='lost'", [opp])).toHaveLength(1);
  });

  it("apply: cliente respondeu depois da despedida, negócio avançado ou flag desligada => nada muda", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const { c, conv } = await silentLead(org);
    const opp = (await q("insert into public.opportunities(organization_id,contact_id,status,stage,operation,initial_operation) values ($1,$2,'open','qualification','vehicle_sale','vehicle_sale') returning id", [org, c]))[0].id;
    const [bye] = await msg(org, conv, "agent", daysAgo(0, 2), "Vou encerrar", { no_reply_closure: {} });
    await msg(org, conv, "contact", daysAgo(0, 1), "espera, quero sim");
    expect((await q("select public.apply_no_reply_closure($1) as n", [bye.id]))[0].n).toBe(0);
    expect((await q("select status from public.opportunities where id=$1", [opp]))[0].status).toBe("open");
    const other = await silentLead(org);
    await q("update public.organizations set settings = settings || '{\"no_reply_closure_enabled\":false}'::jsonb where id=$1", [org]);
    const [bye2] = await msg(org, other.conv, "agent", NOW.toISOString(), "Vou encerrar", { low_intent_followup: { stage: 3 } });
    expect((await q("select public.apply_no_reply_closure($1) as n", [bye2.id]))[0].n).toBe(0);
    expect((await q("select metadata from public.messages where id=$1", [bye2.id]))[0].metadata).not.toHaveProperty("closure_applied_at");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Revisão independente do PR #123 (25/11): regressões escritas antes da correção (vistas falhando no código af744f5).
// ---------------------------------------------------------------------------------------------------------------------------
describe("revisão 25/11 — cliente que volta", () => {
  const triggers = async (org: string, since = "2026-01-01T00:00:00Z", limit = 30) =>
    q("select * from public.returning_customer_triggers($1,$2,$3,$4)", [org, since, ["vehicle_followup", "proposal_followup"], limit]);

  it("gatilhos: com mais de 30 encaminhamentos na janela e os 30 primeiros já decididos, os novos ainda são alcançados", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const c = await contact(org, "5562990009999");
    const conv = await conversation(org, c);
    const prev = await closedOpp(org, c, "lost", reps["Marina"].userId);
    const hs: string[] = [];
    for (let i = 0; i < 35; i++)
      hs.push((await q("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [org, conv, new Date(Date.UTC(2026, 10, 24, 0, i)).toISOString()]))[0].id);
    for (const h of hs.slice(0, 30))
      await q(`insert into public.returning_customer_decisions(organization_id,contact_id,trigger_kind,trigger_id,mode,intent,identity_status,reason,previous_opportunity_id,outcome)
        values ($1,$2,'handoff',$3,'shadow','administrative','resolved','x',$4,'skipped_not_commercial')`, [org, c, h, prev]);
    const got = await triggers(org);
    expect(got.map((r: any) => r.id)).toEqual(hs.slice(30));
    expect(got[0]).toMatchObject({ kind: "handoff", contact_id: c, conversation_id: conv });
  });

  it("identidade transitiva: o grupo é o mesmo partindo de qualquer cadastro (telefone sem 9 -> @lid apontado -> unificado)", async () => {
    const { org } = await seedWorld(db);
    const a = await contact(org, "5562991234567");
    const b = await contact(org, "556291234567", { lid: "4242@lid" });
    const lid = await contact(org, "4242@lid");
    const merged = await contact(org, "4343@lid#merged", { merged_into: lid });
    const ids = async (x: string) => new Set((await q("select public._contact_identity_ids($1,$2) as ids", [org, x]))[0].ids as string[]);
    const all = new Set([a, b, lid, merged]);
    for (const x of [a, b, lid, merged]) expect(await ids(x)).toEqual(all);
  });

  it("dono: sem anterior ativo, sem atribuição e conversa sem dono => rodízio (avança o ponteiro); decisão guarda o dono (idempotente)", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    await q("insert into public.lead_distribution_state(organization_id,last_rotation_order) values ($1,1) on conflict (organization_id) do update set last_rotation_order=1", [org]);
    const c = await contact(org, "5562990002222");
    const conv = await conversation(org, c);
    const prev = await closedOpp(org, c, "lost", null);
    const d = await decision(org, c, conv, prev);
    const id = await open(d);
    expect((await q("select owner_id from public.opportunities where id=$1", [id]))[0].owner_id).toBe(reps["Márcio"].userId);
    expect((await q("select last_rotation_order from public.lead_distribution_state where organization_id=$1", [org]))[0].last_rotation_order).toBe(2);
    expect((await q("select owner_user_id, owner_rule from public.returning_customer_decisions where id=$1", [d]))[0]).toEqual({ owner_user_id: reps["Márcio"].userId, owner_rule: "round_robin" });
    const r = (await q("select public.returning_customer_owner($1) as o", [d]))[0].o;
    expect(r).toEqual({ user_id: reps["Márcio"].userId, rule: "round_robin" });
    expect((await q("select last_rotation_order from public.lead_distribution_state where organization_id=$1", [org]))[0].last_rotation_order).toBe(2);
  });

  it("revisão humana também ganha dono pelo rodízio; ninguém disponível (todos fora) => não cria card e a decisão fica pendente com erro", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const c = await contact(org, "5562990003333");
    const conv = await conversation(org, c);
    const prev = await closedOpp(org, c, "lost", null);
    const rev = await decision(org, c, conv, prev, { intent: "unclear", outcome: "needs_review", operation: null, stage: null });
    expect((await q("select public.returning_customer_owner($1) as o", [rev]))[0].o.user_id).toBeTruthy();
    await q("update public.sales_reps set availability='out' where organization_id=$1", [org]);
    const d = await decision(org, c, conv, prev, { trigger_kind: "task" });
    expect(await open(d)).toBeNull();
    expect((await q("select outcome, last_error from public.returning_customer_decisions where id=$1", [d]))[0]).toEqual({ outcome: "would_create", last_error: "no_available_rep" });
    expect(reps).toBeTruthy();
  });

  it("decisões pendentes (escrita): card não criado ou revisão sem tarefa voltam no ciclo seguinte; sombra e esgotadas não", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const c = await contact(org, "5562990004444");
    const conv = await conversation(org, c);
    const prev = await closedOpp(org, c, "lost", reps["Marina"].userId);
    const create = await decision(org, c, conv, prev);
    const review = await decision(org, c, conv, prev, { trigger_kind: "task", intent: "unclear", outcome: "needs_review", operation: null, stage: null });
    await decision(org, c, conv, prev, { mode: "shadow" });
    const tired = await decision(org, c, conv, prev);
    await q("update public.returning_customer_decisions set attempts=5 where id=$1", [tired]);
    const pend = async () => (await q("select id from public.returning_customer_pending_decisions($1,10)", [org])).map((r: any) => r.id).sort();
    expect(await pend()).toEqual([create, review].sort());
    await q("select public.returning_customer_mark_attempt($1,$2)", [create, "rpc timeout"]);
    expect((await q("select attempts, last_error from public.returning_customer_decisions where id=$1", [create]))[0]).toEqual({ attempts: 1, last_error: "rpc timeout" });
    await open(create);
    await q("update public.returning_customer_decisions set review_task_id=gen_random_uuid() where id=$1", [review]);
    expect(await pend()).toEqual([]);
  });

  it("tarefas: genérica anterior ao fechamento (de outra negociação) não é puxada para o card novo", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const c = await contact(org, "5562990005555");
    const conv = await conversation(org, c);
    const old = (await q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,type,due_date,created_by_type,created_at) values ($1,$2,$3,'ai','proposal_followup',current_date,'ai',now()-interval '10 days') returning id", [org, c, conv]))[0].id;
    const prev = await closedOpp(org, c, "lost", reps["Marina"].userId);
    await q("insert into public.opportunity_events(organization_id,opportunity_id,event_type,evidence,changed_by_type,created_at) values ($1,$2,'lost','x','human',now()-interval '5 days')", [org, prev]);
    const fresh = (await q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,type,due_date,created_by_type) values ($1,$2,$3,'ai','proposal_followup',current_date,'ai') returning id", [org, c, conv]))[0].id;
    const id = await open(await decision(org, c, conv, prev));
    expect((await q("select opportunity_id from public.tasks where id=$1", [old]))[0].opportunity_id).toBeNull();
    expect((await q("select opportunity_id from public.tasks where id=$1", [fresh]))[0].opportunity_id).toBe(id);
  });

  it("origem: a do cadastro vai como histórica; a da nova negociação só com toque de anúncio dentro da janela de 14 dias", async () => {
    const { org, reps } = await seedWorld(db, RC_WRITE);
    const c = await contact(org, "5562990006666", { lead_origin: { source: "meta_ads", identified_at: "2026-10-09T04:33:16Z" } });
    const conv = await conversation(org, c);
    const prev = await closedOpp(org, c, "lost", reps["Marina"].userId);
    const old = await open(await decision(org, c, conv, prev));
    const ev = (await q("select new_value from public.opportunity_events where opportunity_id=$1 and event_type='created'", [old]))[0].new_value;
    expect(ev).not.toHaveProperty("lead_origin");
    expect(ev).toMatchObject({ lead_origin_historico: { source: "meta_ads" }, origin_basis: "indeterminate", ad_touch: null });
    const c2 = await contact(org, "5562990007777");
    const conv2 = await conversation(org, c2);
    const prev2 = await closedOpp(org, c2, "lost", reps["Marina"].userId);
    const d2 = await decision(org, c2, conv2, prev2);
    const stale = (await q("select public.open_returning_customer_opportunity($1,$2) as id", [d2, JSON.stringify({ touched_at: "2026-01-01T00:00:00Z", ad_id: "x" })]))[0].id;
    expect((await q("select new_value from public.opportunity_events where opportunity_id=$1", [stale]))[0].new_value).toMatchObject({ ad_touch: null, origin_basis: "indeterminate" });
  });
});

describe("revisão 25/11 — encerramento sem resposta", () => {
  const NOW = new Date("2026-11-25T15:00:00Z");
  const daysAgo = (d: number, h = 0) => new Date(NOW.getTime() - (d * 24 + h) * 3600_000).toISOString();
  const msg = (org: string, conv: string, role: string, at: string, content = "oi", metadata: object | null = null, evo: string | null = "evo") =>
    q("insert into public.messages(organization_id,conversation_id,role,content,created_at,metadata,evolution_message_id) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [org, conv, role, content, at, metadata && JSON.stringify(metadata), evo]);
  const cands = async (org: string) => q("select * from public.no_reply_closure_candidates($1,$2,24,50)", [org, NOW.toISOString()]);
  async function silent(org: string, phone?: string) {
    const c = await contact(org, phone ?? "556299" + Math.floor(1e7 + Math.random() * 9e7));
    const conv = await conversation(org, c);
    await msg(org, conv, "contact", daysAgo(5), "quero saber o preço");
    await msg(org, conv, "agent", daysAgo(5, -0.1), "Custa R$ 20.900");
    for (let i = 3; i >= 1; i--) await msg(org, conv, "agent", daysAgo(i), "Ficou alguma dúvida?");
    await q("update public.conversations set last_message_at=$2 where id=$1", [conv, daysAgo(1)]);
    return { c, conv };
  }
  const opp = async (org: string, c: string, operation = "vehicle_sale", created = daysAgo(10)) =>
    (await q("insert into public.opportunities(organization_id,contact_id,status,stage,operation,initial_operation,created_at) values ($1,$2,'open','qualification',$3,$3,$4) returning id", [org, c, operation, created]))[0].id as string;

  it("só conta follow-up realmente enviado (com confirmação do WhatsApp)", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const { conv } = await silent(org);
    await q("update public.messages set evolution_message_id=null where conversation_id=$1 and created_at=$2", [conv, daysAgo(2)]);
    expect((await cands(org)).map((r: any) => r.conversation_id)).toEqual([]);
  });

  it("captura o negócio correspondente; dois negócios abertos no grupo => fica de fora (decisão humana)", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const one = await silent(org);
    const o1 = await opp(org, one.c);
    const two = await silent(org);
    await opp(org, two.c);
    await opp(org, two.c, "consortium");
    const r = await cands(org);
    expect(r.map((x: any) => x.conversation_id)).toEqual([one.conv]);
    expect(r[0].opportunity_id).toBe(o1);
  });

  it("resposta do cliente em outra conversa/cadastro do mesmo grupo ou promessa aberta do vendedor => fica de fora", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const a = await silent(org, "5562991230001");
    const lid = await contact(org, "9001@lid#merged", { merged_into: a.c });
    const conv2 = await conversation(org, lid);
    await msg(org, conv2, "contact", daysAgo(1, 2), "oi, ainda quero");
    const b = await silent(org);
    await q("insert into public.seller_commitments(organization_id,conversation_id,contact_id,due_at) values ($1,$2,$3,$4)", [org, b.conv, b.c, daysAgo(-1)]);
    expect((await cands(org)).map((r: any) => r.conversation_id)).toEqual([]);
  });

  it("apply: encerra só o negócio capturado no envio; card criado depois da despedida e outro produto ficam abertos", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const { c, conv } = await silent(org);
    const target = await opp(org, c);
    const [bye] = await msg(org, conv, "agent", daysAgo(0, 3), "Vou encerrar", { no_reply_closure: { followup_days: 4, opportunity_id: target } });
    const later = await opp(org, c, "consortium", daysAgo(0, 2));
    expect((await q("select public.apply_no_reply_closure($1) as n", [bye.id]))[0].n).toBe(1);
    expect((await q("select status from public.opportunities where id=$1", [target]))[0].status).toBe("lost");
    expect((await q("select status from public.opportunities where id=$1", [later]))[0].status).toBe("open");
  });

  it("apply: vendedor mexeu no negócio depois do envio ou cliente respondeu em outro cadastro do grupo => nada muda", async () => {
    const { org } = await seedWorld(db, RC_WRITE);
    const a = await silent(org);
    const oa = await opp(org, a.c);
    const [byeA] = await msg(org, a.conv, "agent", daysAgo(0, 3), "Vou encerrar", { no_reply_closure: { opportunity_id: oa } });
    await q("insert into public.opportunity_events(organization_id,opportunity_id,event_type,evidence,changed_by_type,created_at) values ($1,$2,'next_action_updated','ligar amanhã','human',$3)", [org, oa, daysAgo(0, 2)]);
    expect((await q("select public.apply_no_reply_closure($1) as n", [byeA.id]))[0].n).toBe(0);
    expect((await q("select status from public.opportunities where id=$1", [oa]))[0].status).toBe("open");
    const b = await silent(org, "5562991230002");
    const ob = await opp(org, b.c);
    const lid = await contact(org, "9002@lid#merged", { merged_into: b.c });
    const conv2 = await conversation(org, lid);
    const [byeB] = await msg(org, b.conv, "agent", daysAgo(0, 3), "Vou encerrar", { no_reply_closure: { opportunity_id: ob } });
    await msg(org, conv2, "contact", daysAgo(0, 1), "espera");
    expect((await q("select public.apply_no_reply_closure($1) as n", [byeB.id]))[0].n).toBe(0);
    expect((await q("select status from public.opportunities where id=$1", [ob]))[0].status).toBe("open");
  });
});
