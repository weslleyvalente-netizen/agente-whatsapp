// Todo encaminhamento para humano deixa um card no funil (negócio aberto na etapa inicial) quando o contato não tem nenhum negócio.
// Caso real 27/10: cliente da carteira da Marina pediu carta de crédito, a IA chamou requestHuman, nasceu atribuição + tarefas, mas nenhum negócio.
import { beforeEach, describe, expect, it } from "vitest";
import { inMinutes } from "./harness.js";
import { ALL_ON, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => { ({ db, q } = await setupHandoffDb()); });

const distribute = async (org: string, h: { conversationId: string; handoffId: string }, ctx: object = {}, dueInMinutes = 60) =>
  (await q("select public.distribute_lead($1,$2,$3,$4,$5::jsonb) as id", [org, h.conversationId, h.handoffId, inMinutes(dueInMinutes), JSON.stringify(ctx)]))[0].id as string | null;
const oppsOf = (contact: string) => q("select * from public.opportunities where contact_id=$1 order by created_at", [contact]);
const aiTask = (org: string, contact: string, conversation: string, type: string) =>
  q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,type,due_date,created_by_type) values ($1,$2,$3,'ai',$4,current_date,'ai') returning id", [org, contact, conversation, type]);
const human = (org: string, contact: string, conversation: string, user: string, type: string) =>
  q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,assignee_id,type,due_date,created_by_type) values ($1,$2,$3,'human',$4,$5,current_date,'ai') returning id", [org, contact, conversation, user, type]);

describe("cartão de encaminhamento (distribute_lead)", () => {
  it("caso Márcio/Marina: cliente da carteira, tarefas run_quote + other, sem negócio => nasce 1 negócio da Marina, ligado à atribuição, com marca de operação a confirmar", async () => {
    const { org, def, reps } = await seedWorld(db);
    const h = await seedLead(db, org, { assignedTo: reps["Marina"].userId });
    await human(org, h.contactId, h.conversationId, def, "run_quote");
    await human(org, h.contactId, h.conversationId, def, "other");
    expect(await oppsOf(h.contactId)).toHaveLength(0); // o gatilho de tarefa ignora tipos sem mapeamento
    const id = await distribute(org, h);
    const a = (await q("select * from public.lead_assignments where id=$1", [id]))[0];
    expect(a).toMatchObject({ reason: "existing_owner", sla_action: "alert", status: "pending" });
    const opps = await oppsOf(h.contactId);
    expect(opps).toHaveLength(1);
    expect(opps[0]).toMatchObject({ status: "open", stage: "interest_received", owner_id: reps["Marina"].userId, operation: "vehicle_sale", initial_operation: "vehicle_sale", operation_is_default: true });
    expect(opps[0].owner_assigned_at).not.toBeNull();
    expect(a.opportunity_id).toBe(opps[0].id);
    const ev = await q("select event_type, changed_by_type, evidence, new_value from public.opportunity_events where opportunity_id=$1", [opps[0].id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "created", changed_by_type: "system", evidence: "Negócio criado no encaminhamento para humano (operação a confirmar)" });
    expect(ev[0].new_value).toMatchObject({ source: "handoff_card", operation: "vehicle_sale", operation_is_default: true, operation_source: "default" });
    // as duas tarefas abertas passam a apontar para o negócio
    expect(await q("select id from public.tasks where contact_id=$1 and opportunity_id=$2", [h.contactId, opps[0].id])).toHaveLength(2);
    expect(await q("select 1 from public.task_events where event_type='opportunity_auto_linked'")).toHaveLength(2);
    // tarefas e conversa seguem o vendedor
    expect((await q("select distinct assignee_id from public.tasks where contact_id=$1", [h.contactId])).map(r => r.assignee_id)).toEqual([reps["Marina"].userId]);
    expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).toBe(reps["Marina"].userId);
  });

  it("lead novo do rodízio: negócio do vendedor sorteado, uma vez só (rodar de novo não duplica)", async () => {
    const { org, reps } = await seedWorld(db);
    const h = await seedLead(db, org);
    const id = await distribute(org, h);
    const again = await distribute(org, h);
    expect(again).toBe(id);
    const opps = await oppsOf(h.contactId);
    expect(opps).toHaveLength(1);
    expect(opps[0].owner_id).toBe(reps["Marina"].userId);
    expect((await q("select count(*)::int as n from public.opportunity_events where opportunity_id=$1", [opps[0].id]))[0].n).toBe(1);
  });

  it("operação: contexto do handoff vence; sem marca de padrão", async () => {
    const { org } = await seedWorld(db);
    const h = await seedLead(db, org);
    await distribute(org, h, { operation: "consortium" });
    const [o] = await oppsOf(h.contactId);
    expect(o).toMatchObject({ operation: "consortium", initial_operation: "consortium", operation_is_default: false });
    const ev = (await q("select evidence, new_value from public.opportunity_events where opportunity_id=$1", [o.id]))[0];
    expect(ev.evidence).toBe("Negócio criado no encaminhamento para humano");
    expect(ev.new_value).toMatchObject({ operation_source: "handoff_context", operation_is_default: false });
  });

  it("operação: contexto inválido é ignorado (nunca chuta nem quebra o CHECK)", async () => {
    const { org } = await seedWorld(db);
    const h = await seedLead(db, org);
    await distribute(org, h, { operation: "carro_zero" });
    expect((await oppsOf(h.contactId))[0]).toMatchObject({ operation: "vehicle_sale", operation_is_default: true });
  });

  it("operação: sem contexto, vem do tipo único das tarefas humanas abertas", async () => {
    const { org } = await seedWorld(db);
    const h = await seedLead(db, org);
    await aiTask(org, h.contactId, h.conversationId, "financing_followup"); // a distribuição a promove a humana
    await distribute(org, h);
    expect((await oppsOf(h.contactId))[0]).toMatchObject({ operation: "financing", operation_is_default: false });
    const ev = (await q("select new_value from public.opportunity_events where event_type='created'"))[0];
    expect(ev.new_value.operation_source).toBe("task_type");
  });

  it("operação: tipos de tarefa ambíguos => padrão marcado como 'a confirmar'", async () => {
    const { org } = await seedWorld(db);
    const h = await seedLead(db, org);
    await aiTask(org, h.contactId, h.conversationId, "consortium_followup");
    await aiTask(org, h.contactId, h.conversationId, "vehicle_followup");
    await distribute(org, h);
    expect((await oppsOf(h.contactId))[0]).toMatchObject({ operation: "vehicle_sale", operation_is_default: true });
  });

  it("contato com negócio aberto: não cria outro e a atribuição aponta para o existente", async () => {
    const { org, reps } = await seedWorld(db);
    const h = await seedLead(db, org);
    const opp = (await q("insert into public.opportunities(organization_id,contact_id,operation,initial_operation,stage,owner_id) values ($1,$2,'consortium','consortium','qualification',$3) returning id", [org, h.contactId, reps["Márcio"].userId]))[0].id;
    const id = await distribute(org, h);
    expect(await oppsOf(h.contactId)).toHaveLength(1);
    expect((await q("select opportunity_id from public.lead_assignments where id=$1", [id]))[0].opportunity_id).toBe(opp);
  });

  it("contato só com negócios fechados (ganho/perdido): não reabre nem cria (regra de histórico)", async () => {
    const { org } = await seedWorld(db);
    const h = await seedLead(db, org);
    await q("insert into public.opportunities(organization_id,contact_id,operation,initial_operation,stage,status) values ($1,$2,'consortium','consortium','membership','won'),($1,$2,'financing','financing','qualification','lost')", [org, h.contactId]);
    const id = await distribute(org, h);
    expect(id).toBeTruthy();
    const opps = await oppsOf(h.contactId);
    expect(opps).toHaveLength(2);
    expect(opps.every(o => o.status !== "open")).toBe(true);
  });

  it("flag sales_auto_pipeline_enabled desligada ou diferente de JSON true: não cria", async () => {
    for (const settings of [{ lead_distribution_enabled: true }, { lead_distribution_enabled: true, sales_auto_pipeline_enabled: false }, { lead_distribution_enabled: true, sales_auto_pipeline_enabled: "true" }]) {
      const { org } = await seedWorld(db, settings);
      const h = await seedLead(db, org);
      expect(await distribute(org, h)).toBeTruthy();
      expect(await oppsOf(h.contactId)).toHaveLength(0);
    }
  });

  it("contato ignorado (organization_ignored_contacts): não cria", async () => {
    const { org } = await seedWorld(db);
    const h = await seedLead(db, org, { phone: "5511999990000" });
    await q("insert into public.organization_ignored_contacts(organization_id,phone) values ($1,'5511999990000')", [org]);
    expect(await distribute(org, h)).toBeTruthy();
    expect(await oppsOf(h.contactId)).toHaveLength(0);
  });

  it("distribuição desligada: nada acontece (sem atribuição, sem negócio)", async () => {
    const { org } = await seedWorld(db, { sales_auto_pipeline_enabled: true });
    const h = await seedLead(db, org);
    expect(await distribute(org, h)).toBeNull();
    expect(await oppsOf(h.contactId)).toHaveLength(0);
  });

  it("sem vendedor disponível (exceção): não há dono para o card; ele nasce quando o gestor atribui manualmente", async () => {
    const { org, def, reps } = await seedWorld(db, ALL_ON, [["Marina", 1, "out"]]);
    const h = await seedLead(db, org);
    const exc = await distribute(org, h);
    expect((await q("select status from public.lead_assignments where id=$1", [exc]))[0].status).toBe("exception");
    expect(await oppsOf(h.contactId)).toHaveLength(0);
    await q("update public.sales_reps set availability='available' where id=$1", [reps["Marina"].repId]);
    const id = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [org, h.conversationId, reps["Marina"].repId, def, inMinutes(60)]))[0].id;
    const opps = await oppsOf(h.contactId);
    expect(opps).toHaveLength(1);
    expect(opps[0].owner_id).toBe(reps["Marina"].userId);
    expect((await q("select opportunity_id from public.lead_assignments where id=$1", [id]))[0].opportunity_id).toBe(opps[0].id);
  });

  it("redistribuição por SLA e atribuição manual levam o MESMO negócio, sem criar outro", async () => {
    const { org, def, reps } = await seedWorld(db);
    const h = await seedLead(db, org);
    const first = await distribute(org, h, {}, -1); // prazo já vencido (sla_due_at é imutável)
    const second = (await q("select public.redistribute_assignment($1,$2) as id", [first, inMinutes(30)]))[0].id;
    expect(second).toBeTruthy();
    let opps = await oppsOf(h.contactId);
    expect(opps).toHaveLength(1);
    expect(opps[0].owner_id).toBe(reps["Márcio"].userId);
    await q("select public.manual_assign($1,$2,$3,$4,$5)", [org, h.conversationId, reps["Marina"].repId, def, inMinutes(60)]);
    opps = await oppsOf(h.contactId);
    expect(opps).toHaveLength(1);
    expect(opps[0].owner_id).toBe(reps["Marina"].userId);
  });

  it("convive com trg_owner_on_opportunity_open e trg_sync_owner_on_conversation_assign: dono = vendedor, conversa = vendedor, sem evento de troca de dono", async () => {
    const { org, reps } = await seedWorld(db);
    const h = await seedLead(db, org, { assignedTo: reps["Márcio"].userId });
    await distribute(org, h);
    const [o] = await oppsOf(h.contactId);
    expect(o.owner_id).toBe(reps["Márcio"].userId);
    expect(await q("select 1 from public.opportunity_events where event_type='owner_changed'")).toHaveLength(0);
  });

  it("novo handoff sobre contato que já ganhou card: não cria segundo negócio aberto", async () => {
    const { org } = await seedWorld(db);
    const h = await seedLead(db, org);
    const id = await distribute(org, h);
    await q("update public.lead_assignments set status='accepted', accepted_at=now() where id=$1", [id]);
    const h2 = (await q("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2) returning id", [org, h.conversationId]))[0].id;
    await distribute(org, { conversationId: h.conversationId, handoffId: h2 });
    expect(await q("select id from public.opportunities where contact_id=$1 and status='open'", [h.contactId])).toHaveLength(1);
  });
});

describe("sync_sales_pipeline x negócio com operação a confirmar", () => {
  const fields = { credit_amount: 26500, term_months: 80, usage_purpose: "trabalho", urgency: "alta", commercial_notes: "quer carta", bid_amount: 3000, next_action: "ligar", product_model: "CG160" };
  const turn = async (org: string, h: { conversationId: string }, operation: string, stage: string, explicit = false, correction = true) => {
    const msg = (await q("insert into public.messages(organization_id,conversation_id,role,content) values ($1,$2,'contact','quero uma carta de crédito') returning id", [org, h.conversationId]))[0].id;
    return (await q("select public.sync_sales_pipeline($1,$2,$3,null,$4,$5,$6,$7::jsonb,$8) as id", [org, h.conversationId, msg, operation, stage, explicit, JSON.stringify(fields), correction]))[0].id as string;
  };
  const created = async () => {
    const w = await seedWorld(db);
    const h = await seedLead(db, w.org);
    await distribute(w.org, h);
    const [o] = await oppsOf(h.contactId);
    return { ...w, h, opp: o.id as string };
  };

  it("operação padrão + IA identifica outra operação SEM pedido explícito: corrige a operação (com evento) e segue o funil", async () => {
    const { org, h, opp } = await created();
    const id = await turn(org, h, "consortium", "qualification");
    expect(id).toBe(opp);
    const o = (await q("select * from public.opportunities where id=$1", [opp]))[0];
    expect(o).toMatchObject({ operation: "consortium", stage: "qualification", operation_is_default: false });
    expect(o.initial_operation).toBe("consortium"); // igual ao negócio criado pelo sync antes do card
    const ev = await q("select event_type, evidence from public.opportunity_events where opportunity_id=$1 order by created_at", [opp]);
    expect(ev.map(e => e.event_type)).toEqual(["created", "operation_changed", "stage_changed"]);
    expect(ev[1].evidence).toContain("Operação a confirmar");
    expect(await oppsOf(h.contactId)).toHaveLength(1);
  });

  it("depois de corrigida, uma sugestão não explícita de outra operação NÃO troca de novo", async () => {
    const { org, h, opp } = await created();
    await turn(org, h, "consortium", "qualification");
    await turn(org, h, "financing", "qualification");
    expect((await q("select operation from public.opportunities where id=$1", [opp]))[0].operation).toBe("consortium");
  });

  it("negócio com operação confirmada (sem marca) continua exigindo pedido explícito para trocar", async () => {
    const w = await seedWorld(db);
    const h = await seedLead(db, w.org);
    await distribute(w.org, h, { operation: "vehicle_sale" });
    const [o] = await oppsOf(h.contactId);
    expect(o.operation_is_default).toBe(false);
    await turn(w.org, h, "consortium", "qualification");
    expect((await q("select operation from public.opportunities where id=$1", [o.id]))[0].operation).toBe("vehicle_sale");
    await turn(w.org, h, "consortium", "qualification", true);
    expect((await q("select operation from public.opportunities where id=$1", [o.id]))[0].operation).toBe("consortium");
  });

  it("mesma operação do padrão com evidência: só avança a etapa e a marca é limpa (confirmada)", async () => {
    const { org, h, opp } = await created();
    await turn(org, h, "vehicle_sale", "qualification");
    expect((await q("select operation, stage, operation_is_default from public.opportunities where id=$1", [opp]))[0]).toMatchObject({ operation: "vehicle_sale", stage: "qualification", operation_is_default: false });
  });

  it("vendedor que muda a operação na tela confirma: a marca é limpa e a IA não sobrescreve depois", async () => {
    const { org, h, opp } = await created();
    await q("update public.opportunities set operation='financing' where id=$1", [opp]);
    expect((await q("select operation_is_default from public.opportunities where id=$1", [opp]))[0].operation_is_default).toBe(false);
    await turn(org, h, "consortium", "qualification");
    expect((await q("select operation from public.opportunities where id=$1", [opp]))[0].operation).toBe("financing");
  });

  it("sync_sales_pipeline com contato que já tem o card do encaminhamento nunca cria segundo negócio", async () => {
    const { org, h } = await created();
    await turn(org, h, "consortium", "interest_received");
    expect(await oppsOf(h.contactId)).toHaveLength(1);
  });
});

describe("ordem de deploy, paridade com o caminho de criação, histórico e chave de desligar", () => {
  const COLS = "operation, initial_operation, stage, product_model, sale_amount, credit_amount, down_payment_amount, bid_amount, target_installment_amount, term_months, usage_purpose, urgency, commercial_notes, next_action";
  const fields = { credit_amount: 26500, term_months: 80, usage_purpose: "trabalho", urgency: "alta", commercial_notes: "quer carta", bid_amount: 3000, next_action: "ligar", product_model: "CG160", down_payment_amount: 2000 };
  const sync = async (org: string, conversationId: string, operation: string, stage: string, correction: boolean | undefined, explicit = false) => {
    const msg = (await q("insert into public.messages(organization_id,conversation_id,role,content) values ($1,$2,'contact','quero uma carta') returning id", [org, conversationId]))[0].id;
    if (correction === undefined) // chamada de 8 argumentos, como o worker ANTIGO
      return (await q("select public.sync_sales_pipeline($1,$2,$3,null,$4,$5,$6,$7::jsonb) as id", [org, conversationId, msg, operation, stage, explicit, JSON.stringify(fields)]))[0].id;
    return (await q("select public.sync_sales_pipeline($1,$2,$3,null,$4,$5,$6,$7::jsonb,$8) as id", [org, conversationId, msg, operation, stage, explicit, JSON.stringify(fields), correction]))[0].id;
  };

  it("worker ANTIGO (8 argumentos / sem p_default_correction) nunca limpa a marca nem corrige a operação", async () => {
    const w = await seedWorld(db); const h = await seedLead(db, w.org);
    await distribute(w.org, h);
    await sync(w.org, h.conversationId, "vehicle_sale", "qualification", undefined); // mesma operação, sem sinal novo
    await sync(w.org, h.conversationId, "consortium", "qualification", false);
    const [o] = await oppsOf(h.contactId);
    expect(o).toMatchObject({ operation: "vehicle_sale", operation_is_default: true });
  });

  it("card corrigido pelo sync fica IGUAL ao negócio que o sync criaria antes do card (todos os campos da qualificação e initial_operation)", async () => {
    const withCard = await seedWorld(db); const a = await seedLead(db, withCard.org);
    await distribute(withCard.org, a);
    await sync(withCard.org, a.conversationId, "consortium", "qualification", true);
    const noCard = await seedWorld(db, { ...ALL_ON, handoff_card_enabled: false }); const b = await seedLead(db, noCard.org);
    await distribute(noCard.org, b);
    expect(await oppsOf(b.contactId)).toHaveLength(0);
    await sync(noCard.org, b.conversationId, "consortium", "qualification", false);
    const pick = async (c: string) => (await q(`select ${COLS} from public.opportunities where contact_id=$1`, [c]))[0];
    const ra = await pick(a.contactId); const rb = await pick(b.contactId);
    expect(ra).toEqual(rb);
    expect(ra).toMatchObject({ operation: "consortium", initial_operation: "consortium", credit_amount: "26500", term_months: 80, usage_purpose: "trabalho", bid_amount: "3000" });
    expect((await oppsOf(a.contactId))[0].operation_is_default).toBe(false);
  });

  it("chave handoff_card_enabled: ausente = ligada; só false explícito desliga (distribute_lead e ensure_handoff_cards)", async () => {
    const off = await seedWorld(db, { ...ALL_ON, handoff_card_enabled: false }); const h = await seedLead(db, off.org);
    expect(await distribute(off.org, h)).toBeTruthy();
    expect(await oppsOf(h.contactId)).toHaveLength(0);
    expect((await q("select public.ensure_handoff_cards(50) as n"))[0].n).toBe(0);
    await q("update public.organizations set settings = settings || '{\"handoff_card_enabled\":true}' where id=$1", [off.org]);
    expect((await q("select public.ensure_handoff_cards(50) as n"))[0].n).toBe(1);
    const on = await seedWorld(db, ALL_ON); const h2 = await seedLead(db, on.org); // sem a chave: liga
    await distribute(on.org, h2);
    expect(await oppsOf(h2.contactId)).toHaveLength(1);
  });

  it("card perdido que nunca foi confirmado e sem ação humana (além de 'perdido') NÃO bloqueia o card/negócio automático seguinte", async () => {
    const w = await seedWorld(db); const h = await seedLead(db, w.org);
    const id = await distribute(w.org, h);
    const [card] = await oppsOf(h.contactId);
    await q("update public.opportunities set status='lost' where id=$1", [card.id]);
    await q("insert into public.opportunity_events(organization_id,opportunity_id,event_type,evidence,changed_by_type) values ($1,$2,'lost','sumiu','human')", [w.org, card.id]);
    await q("update public.lead_assignments set status='accepted', accepted_at=now() where id=$1", [id]);
    const h2 = (await q("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2) returning id", [w.org, h.conversationId]))[0].id;
    await distribute(w.org, { conversationId: h.conversationId, handoffId: h2 });
    expect((await q("select status from public.opportunities where contact_id=$1 order by created_at", [h.contactId])).map(r => r.status)).toEqual(["lost", "open"]);
    // e a automação (sync) também cria quando o cliente volta
    const w2 = await seedWorld(db); const g = await seedLead(db, w2.org);
    await distribute(w2.org, g);
    const [c2] = await oppsOf(g.contactId);
    await q("update public.opportunities set status='lost' where id=$1", [c2.id]);
    await q("update public.lead_assignments set status='expired' where conversation_id=$1", [g.conversationId]);
    expect(await sync(w2.org, g.conversationId, "consortium", "interest_received", false)).toBeTruthy();
    expect((await q("select status from public.opportunities where contact_id=$1 order by created_at", [g.contactId])).map(r => r.status)).toEqual(["lost", "open"]);
  });

  it("negócio perdido que o vendedor trabalhou (confirmou a operação, ou evento humano) CONTINUA bloqueando (regra de histórico)", async () => {
    const w = await seedWorld(db); const h = await seedLead(db, w.org);
    await distribute(w.org, h);
    const [card] = await oppsOf(h.contactId);
    await q("update public.opportunities set operation='financing', status='lost' where id=$1", [card.id]); // confirmou a operação: marca cai
    expect((await q("select public._contact_has_deal_history($1,$2) as b", [w.org, h.contactId]))[0].b).toBe(true);
    const w2 = await seedWorld(db); const g = await seedLead(db, w2.org);
    await distribute(w2.org, g);
    const [c2] = await oppsOf(g.contactId);
    await q("update public.opportunities set status='lost' where id=$1", [c2.id]);
    await q("insert into public.opportunity_events(organization_id,opportunity_id,event_type,evidence,changed_by_type) values ($1,$2,'stage_changed','mexeu','human')", [w2.org, c2.id]);
    expect((await q("select public._contact_has_deal_history($1,$2) as b", [w2.org, g.contactId]))[0].b).toBe(true);
  });
});
