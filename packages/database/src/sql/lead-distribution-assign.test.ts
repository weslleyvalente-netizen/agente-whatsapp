// packages/database/src/sql/lead-distribution-assign.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(); });

const distribute = async (org: string, h: { conversationId: string; handoffId: string }, due = inMinutes(15)) =>
  (await db.query<{ id: string | null }>("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, due])).rows[0].id;
const row = async (id: string) => (await db.query<any>("select a.*, r.display_name from public.lead_assignments a left join public.sales_reps r on r.id=a.rep_id where a.id=$1", [id])).rows[0];

describe("distribute_lead: rodízio", () => {
  it("alterna Marina → Márcio → Marina → Márcio", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const names: string[] = [];
    for (let i = 0; i < 4; i++) names.push((await row((await distribute(org, await seedHandoff(db, org)))!)).display_name);
    expect(names).toEqual(["Marina", "Márcio", "Marina", "Márcio"]);
  });

  it("pula o pausado e o fora sem perder a ordem", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2, "paused");
    const first = await row((await distribute(org, await seedHandoff(db, org)))!);
    const second = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect([first.display_name, second.display_name]).toEqual(["Marina", "Marina"]);
    await db.query("update public.sales_reps set availability='available' where organization_id=$1 and display_name='Márcio'", [org]);
    const third = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect(third.display_name).toBe("Márcio"); // volta sem rajada de compensação
    const fourth = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect(fourth.display_name).toBe("Marina");
    expect(marina.repId).toBeTruthy();
  });

  it("mantém o ponteiro no banco: last_rotation_order é a fonte do próximo", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    await distribute(org, await seedHandoff(db, org));
    expect((await db.query<any>("select last_rotation_order from public.lead_distribution_state where organization_id=$1", [org])).rows[0].last_rotation_order).toBe(1);
    // alterar só last_assigned_at não muda quem é o próximo
    await db.query("update public.sales_reps set last_assigned_at = now() + interval '1 day' where display_name='Márcio'");
    expect((await row((await distribute(org, await seedHandoff(db, org)))!)).display_name).toBe("Márcio");
  });
});

describe("distribute_lead: efeitos, contexto e idempotência", () => {
  it("grava dono na conversa, no negócio único aberto e nas tarefas abertas", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    const opp = (await db.query<any>("insert into public.opportunities(organization_id,contact_id,operation,product_model) values ($1,$2,'consortium','Fazer 250') returning id", [org, h.contactId])).rows[0].id;
    await db.query("insert into public.tasks(organization_id,contact_id,status) values ($1,$2,'pending')", [org, h.contactId]);
    const id = (await distribute(org, h))!;
    const a = await row(id);
    expect(a).toMatchObject({ reason: "round_robin", status: "pending", opportunity_id: opp, operation: null });
    const conv = (await db.query<any>("select assigned_to, assigned_at from public.conversations where id=$1", [h.conversationId])).rows[0];
    expect(conv.assigned_to).toBe(marina.userId); expect(conv.assigned_at).not.toBeNull();
    const o = (await db.query<any>("select owner_id, owner_assigned_at from public.opportunities where id=$1", [opp])).rows[0];
    expect(o.owner_id).toBe(marina.userId); expect(o.owner_assigned_at).not.toBeNull();
    expect((await db.query<any>("select assignee_id, assignee_type from public.tasks where contact_id=$1", [h.contactId])).rows[0]).toEqual({ assignee_id: marina.userId, assignee_type: "human" });
  });

  it("copia o contexto recebido para análises futuras", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const h = await seedHandoff(db, org);
    const id = (await db.query<any>("select public.distribute_lead($1,$2,$3,$4,$5::jsonb) as id", [org, h.conversationId, h.handoffId, inMinutes(15), JSON.stringify({ origin_source: "anuncio", operation: "financing", product_model: "Factor" })])).rows[0].id;
    expect(await row(id)).toMatchObject({ origin_source: "anuncio", operation: "financing", product_model: "Factor", strategy_version: "round_robin_v1" });
  });

  it("é idempotente por handoff_event_id (reprocessamento não duplica)", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const one = await distribute(org, h); const two = await distribute(org, h);
    expect(two).toBe(one);
    expect((await db.query<any>("select count(*)::int as n from public.lead_assignments")).rows[0].n).toBe(1);
    expect((await db.query<any>("select last_rotation_order from public.lead_distribution_state")).rows[0].last_rotation_order).toBe(1);
  });

  it("não faz nada com a flag desligada nem para handoff anterior à ativação", async () => {
    const off = await seedOrg(db, {}); await seedRep(db, off, "Marina", 1);
    expect(await distribute(off, await seedHandoff(db, off))).toBeNull();
    const org = await seedOrg(db, { lead_distribution_enabled: true, lead_distribution_activated_at: "2026-10-07T12:00:00Z" });
    await seedRep(db, org, "Marina", 1);
    expect(await distribute(org, await seedHandoff(db, org, "2026-10-07T11:00:00Z"))).toBeNull();
    expect(await distribute(org, await seedHandoff(db, org, "2026-10-07T13:00:00Z"))).not.toBeNull();
  });

  it("segundo handoff enquanto há atribuição ativa devolve a mesma atribuição", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const first = await distribute(org, h);
    const again = (await db.query<any>("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2) returning id", [org, h.conversationId])).rows[0].id;
    expect(await distribute(org, { conversationId: h.conversationId, handoffId: again })).toBe(first);
  });
});

describe("distribute_lead: ação do SLA", () => {
  it("lead novo do rodízio redistribui; dono existente só alerta", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const novo = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect(novo).toMatchObject({ reason: "round_robin", sla_action: "redistribute" });
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h.contactId, marcio.userId]);
    expect(await row((await distribute(org, h))!)).toMatchObject({ reason: "existing_owner", sla_action: "alert" });
  });
});

describe("distribute_lead: dono existente (precedência)", () => {
  it("negócio aberto atual vence; o rodízio não avança", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h.contactId, marcio.userId]);
    const a = await row((await distribute(org, h))!);
    expect(a).toMatchObject({ display_name: "Márcio", reason: "existing_owner" });
    expect((await db.query<any>("select last_rotation_order from public.lead_distribution_state")).rows[0].last_rotation_order).toBe(0);
  });

  it("conversa atual vale quando não há negócio aberto com dono", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("update public.conversations set assigned_to=$2 where id=$1", [h.conversationId, marcio.userId]);
    expect((await row((await distribute(org, h))!)).display_name).toBe("Márcio");
  });

  it("dono pausado mantém o cliente; dono fora volta ao rodízio só neste handoff", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1, "paused"); await seedRep(db, org, "Márcio", 2);
    const h1 = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h1.contactId, marina.userId]);
    expect(await row((await distribute(org, h1))!)).toMatchObject({ display_name: "Marina", reason: "existing_owner" });
    await db.query("update public.sales_reps set availability='out' where id=$1", [marina.repId]);
    const h2 = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h2.contactId, marina.userId]);
    expect(await row((await distribute(org, h2))!)).toMatchObject({ display_name: "Márcio", reason: "round_robin" });
  });

  it("dono que não é vendedor (conta compartilhada/legado) é ignorado", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,gen_random_uuid())", [org, h.contactId]);
    expect((await row((await distribute(org, h))!)).reason).toBe("round_robin");
  });

  it("negócio perdido antigo não prende o cliente ao vendedor", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id,status) values ($1,$2,$3,'lost')", [org, h.contactId, marina.userId]);
    expect((await row((await distribute(org, h))!)).reason).toBe("round_robin");
  });

  it("último responsável vale só dentro da janela de 30 dias", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const old = await seedHandoff(db, org);
    const prev = (await distribute(org, old))!; // Marina (round_robin)
    await db.query("update public.lead_assignments set status='accepted', accepted_at=now() - interval '10 days', accepted_via='button' where id=$1", [prev]);
    await db.query("update public.conversations set assigned_to=null where id=$1", [old.conversationId]);
    const again = await seedHandoff(db, org); // outra conversa do mesmo contato
    await db.query("update public.conversations set contact_id=$2 where id=$1", [again.conversationId, old.contactId]);
    expect(await row((await distribute(org, { conversationId: again.conversationId, handoffId: again.handoffId }))!)).toMatchObject({ display_name: "Marina", reason: "existing_owner" });
    expect(marina.repId && marcio.repId).toBeTruthy();
  });
});

describe("distribute_lead: exceções", () => {
  it("sem nenhum vendedor disponível cria exceção no_available_rep e não quebra", async () => {
    const org = await seedOrg(db); // zero vendedores cadastrados
    const a = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect(a).toMatchObject({ status: "exception", exception_reason: "no_available_rep", rep_id: null });
  });

  it("vendedor removido da organização que ainda é dono vira invalid_existing_owner", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const gone = await seedRep(db, org, "Ex-vendedor", 2, "available", false); // sem organization_members
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h.contactId, gone.userId]);
    expect(await row((await distribute(org, h))!)).toMatchObject({ status: "exception", exception_reason: "invalid_existing_owner" });
  });

  it("donos de vendedores diferentes em negócios abertos viram manual_review", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3),($1,$2,$4)", [org, h.contactId, a.userId, b.userId]);
    expect(await row((await distribute(org, h))!)).toMatchObject({ status: "exception", exception_reason: "manual_review" });
  });
});
