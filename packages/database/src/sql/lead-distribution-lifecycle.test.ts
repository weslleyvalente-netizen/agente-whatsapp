// packages/database/src/sql/lead-distribution-lifecycle.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep, uuid } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(); });

const distribute = async (org: string, h: { conversationId: string; handoffId: string }, due = inMinutes(15)) =>
  (await db.query<{ id: string }>("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, due])).rows[0].id;
const row = async (id: string) => (await db.query<any>("select a.*, r.display_name from public.lead_assignments a left join public.sales_reps r on r.id=a.rep_id where a.id=$1", [id])).rows[0];
const redistribute = async (id: string, due = inMinutes(15)) =>
  (await db.query<{ id: string | null }>("select public.redistribute_assignment($1,$2) as id", [id, due])).rows[0].id;
const past = () => new Date(Date.now() - 60_000).toISOString();

describe("redistribute_assignment", () => {
  it("não faz nada enquanto o SLA não venceu", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org), inMinutes(10));
    expect(await redistribute(id)).toBeNull();
    expect((await row(id)).status).toBe("pending");
  });

  it("vencido: marca estourou, cria atribuição ao outro vendedor e liga as duas, sem apagar nada", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); const first = await distribute(org, h, past());
    const next = (await redistribute(first))!;
    const a = await row(first); const b = await row(next);
    expect(a).toMatchObject({ status: "expired", sla_breached: true, redistribution_reason: "sla_expired", next_assignment_id: next, display_name: "Marina" });
    expect(b).toMatchObject({ status: "pending", reason: "sla_redistribution", previous_assignment_id: first, display_name: "Márcio", chain_id: a.chain_id });
    expect(b.handoff_at.toISOString()).toBe(a.handoff_at.toISOString()); // KPI cobre a cadeia inteira
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marcio.userId);
    expect((await db.query<any>("select count(*)::int as n from public.lead_assignments")).rows[0].n).toBe(2);
  });

  it("move o ponteiro para quem recebeu, então o próximo lead novo vai ao outro vendedor", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    await redistribute(await distribute(org, await seedHandoff(db, org), past())); // Marina → Márcio
    expect((await row(await distribute(org, await seedHandoff(db, org)))).display_name).toBe("Marina");
  });

  it("sem vai e volta: se o segundo também estourar, vira exceção all_reps_sla_breached", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const first = await distribute(org, await seedHandoff(db, org), past());
    const second = (await redistribute(first, past()))!;
    const third = (await redistribute(second))!;
    expect(await row(third)).toMatchObject({ status: "exception", exception_reason: "all_reps_sla_breached", rep_id: null, previous_assignment_id: second });
    expect(await redistribute(third)).toBeNull();
  });

  it("não redistribui o que já foi assumido, e uma segunda chamada é inócua", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org), past());
    await db.query("select public.accept_assignment($1,$2,false)", [id, marina.userId]);
    expect(await redistribute(id)).toBeNull();
    expect(await redistribute(id)).toBeNull();
    expect((await row(id)).status).toBe("accepted");
  });

  it("segunda chamada sobre a mesma atribuição vencida não cria duplicata", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org), past());
    expect(await redistribute(id)).not.toBeNull();
    expect(await redistribute(id)).toBeNull();
  });

  it("com o outro vendedor pausado, vai para exceção em vez de ficar parado", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2, "paused");
    const created = await redistribute(await distribute(org, await seedHandoff(db, org), past()));
    expect(await row(created!)).toMatchObject({ status: "exception", exception_reason: "all_reps_sla_breached" });
  });
});

describe("dono existente: sem redistribuição automática, só alerta", () => {
  it("cliente que já é da Marina e estoura o prazo continua com a Marina", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h.contactId, marina.userId]);
    const id = await distribute(org, h, past());
    expect(await row(id)).toMatchObject({ reason: "existing_owner", sla_action: "alert" });
    expect(await redistribute(id)).toBeNull();
    expect((await row(id)).status).toBe("pending");
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marina.userId);
  });

  it("flag_sla_alerts marca o atraso sem mudar de vendedor e é idempotente", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h.contactId, marina.userId]);
    const id = await distribute(org, h, past());
    expect((await db.query<any>("select public.flag_sla_alerts() as n")).rows[0].n).toBe(1);
    expect(await row(id)).toMatchObject({ sla_breached: true, status: "pending", display_name: "Marina" });
    expect((await db.query<any>("select public.flag_sla_alerts() as n")).rows[0].n).toBe(0);
  });

  it("não marca alerta antes de vencer, nem em lead novo do rodízio", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    await distribute(org, await seedHandoff(db, org), past()); // round_robin vencido: é redistribuído, não alertado
    const h = await seedHandoff(db, org); // dono existente com prazo ainda não vencido
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h.contactId, (await db.query<any>("select user_id from public.sales_reps where organization_id=$1", [org])).rows[0].user_id]);
    const ok = await distribute(org, h, inMinutes(30));
    expect((await row(ok)).sla_action).toBe("alert");
    expect((await db.query<any>("select public.flag_sla_alerts() as n")).rows[0].n).toBe(0);
  });

  it("reatribuição manual do gestor também não é desfeita por SLA", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); await distribute(org, h); const adminId = await uuid(db);
    const id = (await db.query<any>("select public.manual_assign($1,$2,$3,$4,$5) as id", [org, h.conversationId, marcio.repId, adminId, past()])).rows[0].id;
    expect(await row(id)).toMatchObject({ reason: "manual", sla_action: "alert" });
    expect(await redistribute(id)).toBeNull();
  });
});

describe("accept_assignment", () => {
  it("o vendedor atribuído assume; outro vendedor não; admin assume em nome dele", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org));
    await expect(db.query("select public.accept_assignment($1,$2,false)", [id, marcio.userId])).rejects.toThrow(/Somente o vendedor/);
    const adminId = await uuid(db);
    await db.query("select public.accept_assignment($1,$2,true)", [id, adminId]);
    expect(await row(id)).toMatchObject({ status: "accepted", accepted_via: "admin" });
    expect(marina.userId).toBeTruthy();
  });

  it("flag de admin nulo não abre exceção: ator fora da atribuição é recusado", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org));
    await expect(db.query("select public.accept_assignment($1,$2,null)", [id, marcio.userId])).rejects.toThrow(/Somente o vendedor/);
  });

  it("aceite do vendedor registra o botão e a hora", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const id = await distribute(org, await seedHandoff(db, org));
    expect((await db.query<any>("select public.accept_assignment($1,$2,false) as ok", [id, marina.userId])).rows[0].ok).toBe(true);
    const a = await row(id); expect(a).toMatchObject({ status: "accepted", accepted_via: "button" }); expect(a.accepted_at).not.toBeNull();
    expect((await db.query<any>("select public.accept_assignment($1,$2,false) as ok", [id, marina.userId])).rows[0].ok).toBe(false); // já assumido
  });
});

describe("record_human_message", () => {
  const record = async (org: string, conv: string, author: string | null, via: string, at = new Date().toISOString()) =>
    (await db.query<{ id: string | null }>("select public.record_human_message($1,$2,$3,$4,$5) as id", [org, conv, at, author, via])).rows[0].id;

  it("primeira mensagem do painel pelo vendedor atribuído assume e marca a primeira resposta", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h);
    expect(await record(org, h.conversationId, marina.userId, "panel")).toBe(id);
    const a = await row(id);
    expect(a).toMatchObject({ status: "accepted", accepted_via: "first_message", first_human_message_by: marina.userId });
    expect(a.first_human_message_at).not.toBeNull();
  });

  it("mensagem de um admin registra a primeira resposta mas NÃO assume o lead", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h); const adminId = await uuid(db);
    await record(org, h.conversationId, adminId, "panel");
    expect(await row(id)).toMatchObject({ status: "pending", accepted_at: null, first_human_message_by: adminId });
  });

  it("eco do celular assume só quando a conversa está atribuída ao vendedor da atribuição", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h);
    await record(org, h.conversationId, null, "phone_echo");
    expect(await row(id)).toMatchObject({ status: "accepted", accepted_via: "phone_echo" });
    expect(marina.userId).toBeTruthy();
  });

  it("eco do celular não assume se a conversa foi atribuída a outra pessoa", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h);
    await db.query("update public.conversations set assigned_to=gen_random_uuid() where id=$1", [h.conversationId]);
    await record(org, h.conversationId, null, "phone_echo");
    expect((await row(id)).status).toBe("pending");
  });

  it("só a primeira mensagem conta; as seguintes não alteram o marco", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h);
    const t1 = new Date(Date.now() + 60_000).toISOString(), t2 = new Date(Date.now() + 120_000).toISOString();
    await record(org, h.conversationId, marina.userId, "panel", t1);
    await record(org, h.conversationId, marina.userId, "panel", t2);
    expect((await row(id)).first_human_message_at.toISOString()).toBe(t1);
  });

  it("mensagem humana atualiza last_commercial_activity_at do negócio aberto (mantém a carteira)", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    const opp = (await db.query<any>("insert into public.opportunities(organization_id,contact_id) values ($1,$2) returning id", [org, h.contactId])).rows[0].id;
    await distribute(org, h);
    const t1 = new Date(Date.now() + 60_000).toISOString();
    await record(org, h.conversationId, marina.userId, "panel", t1);
    const o = (await db.query<any>("select last_commercial_activity_at from public.opportunities where id=$1", [opp])).rows[0];
    expect(o.last_commercial_activity_at.toISOString()).toBe(t1);
  });

  it("eco atrasado do vendedor anterior (anterior à atribuição ativa) não assume nem marca a nova linha, mas mantém a carteira", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const opp = (await db.query<any>("insert into public.opportunities(organization_id,contact_id) values ($1,$2) returning id", [org, h.contactId])).rows[0].id;
    const next = (await redistribute(await distribute(org, h, past())))!; // Marina -> Márcio
    const early = new Date(Date.now() - 30_000).toISOString();
    expect(await record(org, h.conversationId, null, "phone_echo", early)).toBe(next);
    expect(await row(next)).toMatchObject({ status: "pending", accepted_at: null, first_human_message_at: null, first_human_message_by: null });
    const o = (await db.query<any>("select last_commercial_activity_at from public.opportunities where id=$1", [opp])).rows[0];
    expect(o.last_commercial_activity_at.toISOString()).toBe(early);
  });

  it("mensagem atrasada do painel pelo vendedor anterior não marca first_human_message_by na nova linha", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const next = (await redistribute(await distribute(org, h, past())))!;
    await record(org, h.conversationId, marina.userId, "panel", new Date(Date.now() - 30_000).toISOString());
    expect(await row(next)).toMatchObject({ status: "pending", first_human_message_at: null, first_human_message_by: null });
  });

  it("p_via nulo ou inválido é recusado", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    await expect(db.query("select public.record_human_message($1,$2,now(),null,null)", [org, h.conversationId])).rejects.toThrow(/inválida/);
    await expect(db.query("select public.record_human_message($1,$2,now(),null,'sms')", [org, h.conversationId])).rejects.toThrow(/inválida/);
  });

  it("sem atribuição ativa devolve NULL (feature desligada ou conversa antiga)", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    expect(await record(org, h.conversationId, await uuid(db), "panel")).toBeNull();
  });
});

describe("manual_assign", () => {
  it("resolve uma exceção atribuindo a um vendedor, preservando o histórico", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    const exc = await distribute(org, h); // sem vendedores: exceção
    const marina = await seedRep(db, org, "Marina", 1); const adminId = await uuid(db);
    const id = (await db.query<any>("select public.manual_assign($1,$2,$3,$4,$5) as id", [org, h.conversationId, marina.repId, adminId, inMinutes(15)])).rows[0].id;
    expect(await row(id)).toMatchObject({ reason: "manual", status: "pending", display_name: "Marina", previous_assignment_id: exc });
    expect(await row(exc)).toMatchObject({ status: "exception", resolved_by: adminId, resolution: "manual_assignment", next_assignment_id: id });
  });

  it("reatribui um lead ativo: o antigo vira redistributed", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); const first = await distribute(org, h); const adminId = await uuid(db);
    const id = (await db.query<any>("select public.manual_assign($1,$2,$3,$4,$5) as id", [org, h.conversationId, marcio.repId, adminId, inMinutes(15)])).rows[0].id;
    expect(await row(first)).toMatchObject({ status: "redistributed", redistribution_reason: "manual", next_assignment_id: id });
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marcio.userId);
    expect(marina.repId).toBeTruthy();
  });

  it("recusa vendedor fora da distribuição e conversa sem histórico", async () => {
    const org = await seedOrg(db); const out = await seedRep(db, org, "Marina", 1, "out");
    const h = await seedHandoff(db, org); await distribute(org, h); const adminId = await uuid(db);
    await expect(db.query("select public.manual_assign($1,$2,$3,$4,$5)", [org, h.conversationId, out.repId, adminId, inMinutes(15)])).rejects.toThrow(/fora/i);
    const lone = await seedHandoff(db, org);
    await expect(db.query("select public.manual_assign($1,$2,$3,$4,$5)", [org, lone.conversationId, out.repId, adminId, inMinutes(15)])).rejects.toThrow(/sem atribui/i);
  });
});

describe("manual_assign (validações)", () => {
  const manual = (org: string, conv: string, rep: string, actor: string) =>
    db.query("select public.manual_assign($1,$2,$3,$4,$5)", [org, conv, rep, actor, inMinutes(15)]);

  it("recusa reatribuir ao vendedor que já está com o lead", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); await distribute(org, h);
    await expect(manual(org, h.conversationId, marina.repId, await uuid(db))).rejects.toThrow(/já está com este vendedor/);
  });

  it("recusa vendedor que deixou de ser membro e vendedor de outra organização", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); await distribute(org, h);
    const ex = await seedRep(db, org, "Ex", 2, "available", false);
    await expect(manual(org, h.conversationId, ex.repId, await uuid(db))).rejects.toThrow(/não é mais membro/);
    const other = await seedOrg(db); const stranger = await seedRep(db, other, "Outro", 1);
    await expect(manual(org, h.conversationId, stranger.repId, await uuid(db))).rejects.toThrow(/inexistente/);
  });
});

describe("marcar um vendedor como out", () => {
  it("não move nenhum lead (sem redistribuição em massa)", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) { ids.push(await distribute(org, await seedHandoff(db, org))); await db.query("update public.lead_distribution_state set last_rotation_order=0 where organization_id=$1", [org]); }
    await db.query("update public.sales_reps set availability='out' where id=$1", [marina.repId]);
    const rows = (await db.query<any>("select status, count(*)::int as n from public.lead_assignments group by status")).rows;
    expect(rows).toEqual([{ status: "pending", n: 3 }]);
  });
});
