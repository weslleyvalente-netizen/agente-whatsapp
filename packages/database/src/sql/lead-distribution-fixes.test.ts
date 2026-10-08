// packages/database/src/sql/lead-distribution-fixes.test.ts
// Correções da revisão final (C1 regressão, C2 novo handoff, I2 distribution_error, I4 contexto, I5 linhas antigas).
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(); });

const distribute = async (org: string, h: { conversationId: string; handoffId: string }, due = inMinutes(15), ctx: Record<string, unknown> = {}) =>
  (await db.query<{ id: string | null }>("select public.distribute_lead($1,$2,$3,$4,$5::jsonb) as id", [org, h.conversationId, h.handoffId, due, JSON.stringify(ctx)])).rows[0].id;
const row = async (id: string) => (await db.query<any>("select a.*, r.display_name from public.lead_assignments a left join public.sales_reps r on r.id=a.rep_id where a.id=$1", [id])).rows[0];
const newHandoff = async (org: string, conversationId: string) =>
  (await db.query<{ id: string }>("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2) returning id", [org, conversationId])).rows[0].id;
const accept = async (id: string, userId: string) => db.query("select public.accept_assignment($1,$2,false)", [id, userId]);
const pointer = async (org: string) => (await db.query<any>("select last_rotation_order from public.lead_distribution_state where organization_id=$1", [org])).rows[0].last_rotation_order;
const count = async () => (await db.query<any>("select count(*)::int as n from public.lead_assignments")).rows[0].n;
const past = () => new Date(Date.now() - 60_000).toISOString();

describe("C1: o responsável padrão escrito ANTES da distribuição contamina a decisão", () => {
  it("regressão: com assigned_to pré-preenchido (requestHuman antigo) todo lead vira existing_owner da Marina e o ponteiro trava", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const h = await seedHandoff(db, org);
      // O requestHuman antigo gravava default_handoff_assignee_id (a Marina) antes de distribuir.
      await db.query("update public.conversations set assigned_to=$2 where id=$1", [h.conversationId, marina.userId]);
      const a = await row((await distribute(org, h))!);
      outcomes.push(`${a.display_name}:${a.reason}`);
    }
    expect(outcomes).toEqual(Array(4).fill("Marina:existing_owner"));
    expect(await pointer(org)).toBe(0);
  });

  it("com a conversa limpa (escrita adiada para depois da distribuição) o rodízio alterna Marina → Márcio", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const a = await row((await distribute(org, await seedHandoff(db, org)))!);
      outcomes.push(`${a.display_name}:${a.reason}`);
    }
    expect(outcomes).toEqual(["Marina:round_robin", "Márcio:round_robin", "Marina:round_robin", "Márcio:round_robin"]);
  });
});

describe("C2: novo handoff numa conversa com atribuição ativa", () => {
  it("lead aceito: mesmo vendedor fica com o lead numa NOVA linha pendente 'alert'; a antiga vira redistributed/new_handoff", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.tasks(organization_id,contact_id,status) values ($1,$2,'pending')", [org, h.contactId]);
    const first = (await distribute(org, h))!;
    await accept(first, marina.userId);
    const tasksBefore = (await db.query<any>("select id, assignee_id, assignee_type, status from public.tasks where contact_id=$1 order by id", [h.contactId])).rows;

    const second = (await distribute(org, { conversationId: h.conversationId, handoffId: await newHandoff(org, h.conversationId) }))!;
    expect(second).not.toBe(first);
    const old = await row(first); const fresh = await row(second);
    expect(old).toMatchObject({ status: "redistributed", redistribution_reason: "new_handoff", next_assignment_id: second });
    expect(fresh).toMatchObject({ status: "pending", reason: "existing_owner", sla_action: "alert", display_name: "Marina", previous_assignment_id: first });
    expect(fresh.chain_id).not.toBe(old.chain_id);
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marina.userId);
    expect((await db.query<any>("select id, assignee_id, assignee_type, status from public.tasks where contact_id=$1 order by id", [h.contactId])).rows).toEqual(tasksBefore);
    expect(await pointer(org)).toBe(1); // dono existente não avança o rodízio
  });

  it("lead aceito cujo dono agora está 'out' passa pelo rodízio no novo handoff", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const first = (await distribute(org, h))!;
    await accept(first, marina.userId);
    await db.query("update public.sales_reps set availability='out' where id=$1", [marina.repId]);
    const second = (await distribute(org, { conversationId: h.conversationId, handoffId: await newHandoff(org, h.conversationId) }))!;
    expect(await row(second)).toMatchObject({ reason: "round_robin", sla_action: "redistribute", display_name: "Márcio", status: "pending", previous_assignment_id: first });
    expect(await row(first)).toMatchObject({ status: "redistributed", redistribution_reason: "new_handoff" });
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marcio.userId);
    expect(await pointer(org)).toBe(2);
  });

  it("o mesmo handoff processado duas vezes continua idempotente (sem segundo supersede)", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const first = (await distribute(org, h))!;
    await accept(first, marina.userId);
    const h2 = { conversationId: h.conversationId, handoffId: await newHandoff(org, h.conversationId) };
    const second = (await distribute(org, h2))!;
    expect(await distribute(org, h2)).toBe(second);
    expect(await distribute(org, h)).toBe(first);
    expect(await count()).toBe(2);
    expect((await row(second)).status).toBe("pending");
  });

  it("atribuição ativa pendente + outro handoff devolve a mesma linha sem mudar nada", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.tasks(organization_id,contact_id,status) values ($1,$2,'pending')", [org, h.contactId]);
    const first = (await distribute(org, h))!;
    const before = await row(first);
    expect(await distribute(org, { conversationId: h.conversationId, handoffId: await newHandoff(org, h.conversationId) })).toBe(first);
    expect(await row(first)).toEqual(before);
    expect(await count()).toBe(1);
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marina.userId);
    expect((await db.query<any>("select assignee_id from public.tasks where contact_id=$1", [h.contactId])).rows[0].assignee_id).toBe(marina.userId);
  });

  it("uma exceção antiga em aberto é resolvida quando chega um novo handoff", async () => {
    const org = await seedOrg(db); // ninguém disponível ainda
    const h = await seedHandoff(db, org);
    const exc = (await distribute(org, h))!;
    expect(await row(exc)).toMatchObject({ status: "exception", exception_reason: "no_available_rep", resolved_at: null });
    await seedRep(db, org, "Marina", 1);
    const next = (await distribute(org, { conversationId: h.conversationId, handoffId: await newHandoff(org, h.conversationId) }))!;
    expect(await row(next)).toMatchObject({ status: "pending", display_name: "Marina" });
    const resolved = await row(exc);
    expect(resolved.resolution).toBe("superseded_by_new_handoff");
    expect(resolved.resolved_at).not.toBeNull();
  });
});

describe("I4: contexto preenchido a partir do negócio aberto", () => {
  it("sem operation/product_model no contexto, copia do único negócio aberto do contato", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,operation,product_model) values ($1,$2,'consortium','Fazer 250')", [org, h.contactId]);
    expect(await row((await distribute(org, h))!)).toMatchObject({ operation: "consortium", product_model: "Fazer 250", origin_source: null });
  });

  it("o contexto explícito vence; com dois negócios abertos não adivinha", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,operation,product_model) values ($1,$2,'consortium','Fazer 250')", [org, h.contactId]);
    expect(await row((await distribute(org, h, inMinutes(15), { operation: "financing" }))!)).toMatchObject({ operation: "financing", product_model: "Fazer 250" });
    const h2 = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,operation,product_model) values ($1,$2,'consortium','A'),($1,$2,'financing','B')", [org, h2.contactId]);
    expect(await row((await distribute(org, h2))!)).toMatchObject({ operation: null, product_model: null });
  });

  it("exceções também recebem o contexto", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,operation,product_model) values ($1,$2,'vehicle_sale','Factor')", [org, h.contactId]);
    expect(await row((await distribute(org, h))!)).toMatchObject({ status: "exception", operation: "vehicle_sale", product_model: "Factor" });
  });
});

describe("I5: linhas pendentes anteriores à (re)ativação não são redistribuídas em massa", () => {
  const redistribute = async (id: string) => (await db.query<{ id: string | null }>("select public.redistribute_assignment($1,$2) as id", [id, inMinutes(15)])).rows[0].id;

  it("pendente atribuída antes de lead_distribution_activated_at vira expired/stale_before_activation, sem nova atribuição", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const id = (await distribute(org, h, past()))!;
    // Flag desligada e religada: activated_at fica depois do assigned_at da linha antiga.
    await db.query("update public.organizations set settings = settings || jsonb_build_object('lead_distribution_activated_at', (now() + interval '1 second')::text) where id=$1", [org]);
    expect(await redistribute(id)).toBeNull();
    expect(await row(id)).toMatchObject({ status: "expired", redistribution_reason: "stale_before_activation", next_assignment_id: null, sla_breached: false });
    expect(await count()).toBe(1);
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marina.userId);
    expect(await pointer(org)).toBe(1);
    // Saiu da fila da varredura.
    expect((await db.query<any>("select count(*)::int as n from public.lead_assignments where status='pending' and sla_action='redistribute'")).rows[0].n).toBe(0);
  });

  it("pendente atribuída depois da ativação continua sendo redistribuída normalmente", async () => {
    const org = await seedOrg(db, { lead_distribution_enabled: true, lead_distribution_activated_at: "2026-01-01T00:00:00Z" });
    await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const id = (await distribute(org, await seedHandoff(db, org), past()))!;
    const next = await redistribute(id);
    expect(next).not.toBeNull();
    expect(await row(next!)).toMatchObject({ reason: "sla_redistribution", display_name: "Márcio" });
  });
});

describe("I2: record_distribution_error", () => {
  const record = async (org: string, h: { conversationId: string; handoffId: string }, msg = "boom") =>
    (await db.query<{ id: string | null }>("select public.record_distribution_error($1,$2,$3,$4) as id", [org, h.conversationId, h.handoffId, msg])).rows[0].id;

  it("cria exceção distribution_error (sem vendedor, cadeia nova, handoff_at do evento)", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org, "2026-10-07T13:00:00Z");
    const id = (await record(org, h))!;
    const a = await row(id);
    expect(a).toMatchObject({ status: "exception", reason: "exception", exception_reason: "distribution_error", rep_id: null, previous_assignment_id: null, strategy_version: "round_robin_v1", handoff_event_id: h.handoffId });
    expect(a.handoff_at.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    expect(a.chain_id).toBeTruthy();
  });

  it("é idempotente por handoff (e não duplica se a distribuição já gravou algo)", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    const id = (await record(org, h))!;
    expect(await record(org, h)).toBe(id);
    expect(await distribute(org, h)).toBe(id);
    expect(await count()).toBe(1);
    const h2 = await seedHandoff(db, org);
    const ok = (await distribute(org, h2))!;
    expect(await record(org, h2)).toBe(ok);
    expect(await count()).toBe(2);
  });

  it("não faz nada com a flag desligada", async () => {
    const org = await seedOrg(db, { lead_distribution_shadow_enabled: true });
    expect(await record(org, await seedHandoff(db, org))).toBeNull();
    expect(await count()).toBe(0);
  });

  it("um novo handoff resolve a exceção distribution_error anterior", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    const exc = (await record(org, h))!;
    await distribute(org, { conversationId: h.conversationId, handoffId: await newHandoff(org, h.conversationId) });
    expect((await row(exc)).resolution).toBe("superseded_by_new_handoff");
  });
});
