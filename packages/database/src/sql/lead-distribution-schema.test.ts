// packages/database/src/sql/lead-distribution-schema.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(["20261007120000_lead_distribution_schema.sql"]); });

async function insertAssignment(orgId: string, h: Awaited<ReturnType<typeof seedHandoff>>, repId: string, extra: Record<string, unknown> = {}) {
  const row = {
    chain_id: crypto.randomUUID(), reason: "round_robin", status: "pending", sla_due_at: inMinutes(15), previous_assignment_id: null, sla_action: "redistribute", ...extra,
  };
  return (await db.query<{ id: string }>(
    `insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,handoff_at,sla_due_at,strategy_version,previous_assignment_id,sla_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,'round_robin_v1',$10,$11) returning id`,
    [orgId, row.chain_id, h.handoffId, h.contactId, h.conversationId, repId, row.reason, row.status, row.sla_due_at, row.previous_assignment_id, row.sla_action])).rows[0].id;
}

describe("lead_assignments schema", () => {
  it("permite uma única atribuição ativa por conversa", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const first = await insertAssignment(org, h, a.repId);
    await expect(insertAssignment(org, h, b.repId, { previous_assignment_id: first })).rejects.toThrow(/one_active_per_conversation/);
  });

  it("rejeita segunda linha do mesmo handoff sem previous_assignment_id", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await insertAssignment(org, h, a.repId, { status: "expired" });
    await expect(insertAssignment(org, h, b.repId)).rejects.toThrow(/one_chain_per_handoff/);
  });

  it("impede o mesmo vendedor duas vezes na mesma cadeia automática", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const chain = crypto.randomUUID();
    const first = await insertAssignment(org, h, a.repId, { chain_id: chain, status: "expired" });
    expect(first).toBeTruthy();
    await expect(insertAssignment(org, h, a.repId, { chain_id: chain, reason: "sla_redistribution", previous_assignment_id: first })).rejects.toThrow(/one_rep_per_chain/);
  });

  it("permite repetir o vendedor em atribuição manual (decisão do gestor)", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const chain = crypto.randomUUID();
    const first = await insertAssignment(org, h, a.repId, { chain_id: chain, status: "expired" });
    await expect(insertAssignment(org, h, a.repId, { chain_id: chain, reason: "manual", previous_assignment_id: first })).resolves.toBeTruthy();
  });

  it("exige rep_id nulo exatamente quando o estado é exceção", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    await expect(db.query(
      `insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,handoff_at,strategy_version)
       values ($1,gen_random_uuid(),$2,$3,$4,null,'exception','pending',now(),'round_robin_v1')`,
      [org, h.handoffId, h.contactId, h.conversationId])).rejects.toThrow();
  });
});

describe("sla_action", () => {
  it("padrão redistribute, aceita alert, rejeita outro valor e é imutável", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await insertAssignment(org, h, a.repId);
    expect((await db.query<any>("select sla_action from public.lead_assignments where id=$1", [id])).rows[0].sla_action).toBe("redistribute");
    await expect(db.query("update public.lead_assignments set sla_action='alert' where id=$1", [id])).rejects.toThrow(/imut/i);
    const h3 = await seedHandoff(db, org);
    await expect(insertAssignment(org, h3, a.repId, { sla_action: "alert" })).resolves.toBeTruthy();
    const h2 = await seedHandoff(db, org);
    await expect(db.query(
      `insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,handoff_at,sla_action,strategy_version)
       values ($1,gen_random_uuid(),$2,$3,$4,$5,'round_robin','pending',now(),'tanto-faz','round_robin_v1')`,
      [org, h2.handoffId, h2.contactId, h2.conversationId, a.repId])).rejects.toThrow(/sla_action|check/i);
  });
});

describe("imutabilidade do histórico", () => {
  it("rejeita DELETE e mudança de campos protegidos", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); const id = await insertAssignment(org, h, a.repId);
    await expect(db.query("delete from public.lead_assignments where id=$1", [id])).rejects.toThrow(/imut/i);
    await expect(db.query("update public.lead_assignments set rep_id=$2 where id=$1", [id, b.repId])).rejects.toThrow(/imut/i);
    await expect(db.query("update public.lead_assignments set reason='manual' where id=$1", [id])).rejects.toThrow(/imut/i);
    await expect(db.query("update public.lead_assignments set assigned_at=now() - interval '1 day' where id=$1", [id])).rejects.toThrow(/imut/i);
    await expect(db.query("update public.lead_assignments set handoff_at=now() where id=$1", [id])).rejects.toThrow(/imut/i);
  });

  it("permite avançar o estado e registrar aceite", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await insertAssignment(org, h, a.repId);
    await db.query("update public.lead_assignments set status='accepted', accepted_at=now(), accepted_via='button' where id=$1", [id]);
    const row = (await db.query<any>("select status, accepted_via from public.lead_assignments where id=$1", [id])).rows[0];
    expect(row).toMatchObject({ status: "accepted", accepted_via: "button" });
  });

  it("next_assignment_id só pode ser preenchido uma vez", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); const chain = crypto.randomUUID();
    const one = await insertAssignment(org, h, a.repId, { chain_id: chain, status: "expired" });
    const two = await insertAssignment(org, h, b.repId, { chain_id: chain, reason: "sla_redistribution", previous_assignment_id: one });
    await db.query("update public.lead_assignments set next_assignment_id=$2 where id=$1", [one, two]);
    await expect(db.query("update public.lead_assignments set next_assignment_id=$2 where id=$1", [one, one])).rejects.toThrow(/imut/i);
  });
});

describe("lead_response_metrics", () => {
  it("calcula os três intervalos de tempo", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await insertAssignment(org, h, a.repId);
    await db.query(
      `update public.lead_assignments set accepted_at = assigned_at + interval '120 seconds', accepted_via='button', status='accepted',
         first_human_message_at = assigned_at + interval '300 seconds' where id=$1`, [id]);
    const m = (await db.query<any>("select * from public.lead_response_metrics where assignment_id=$1", [id])).rows[0];
    expect(m.assigned_to_accepted_seconds).toBe(120);
    expect(m.assigned_to_first_human_seconds).toBe(300);
    expect(m.handoff_to_first_human_seconds).toBeGreaterThanOrEqual(300);
  });
});

describe("exceções", () => {
  const ins = (org: string, h: Awaited<ReturnType<typeof seedHandoff>>, rep: string | null, reason: string | null) => db.query(
    `insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,handoff_at,exception_reason,strategy_version)
     values ($1,gen_random_uuid(),$2,$3,$4,$5,'exception','exception',now(),$6,'round_robin_v1')`,
    [org, h.handoffId, h.contactId, h.conversationId, rep, reason]);

  it("rejeita exceção com vendedor", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const h = await seedHandoff(db, org);
    await expect(ins(org, h, a.repId, "no_available_rep")).rejects.toThrow();
  });
  it("rejeita exceção sem exception_reason", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    await expect(ins(org, h, null, null)).rejects.toThrow();
  });
  it("aceita exceção válida", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    await expect(ins(org, h, null, "no_available_rep")).resolves.toBeTruthy();
  });
});

describe("campos protegidos adicionais", () => {
  it("rejeita mudar os seis campos e permite os mutáveis", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await insertAssignment(org, h, a.repId);
    const opp = (await db.query<{ id: string }>("insert into public.opportunities(organization_id,contact_id) values ($1,$2) returning id", [org, h.contactId])).rows[0].id;
    for (const [col, val] of [
      ["opportunity_id", `'${opp}'`], ["sla_due_at", "now() + interval '1 day'"], ["exception_reason", "'manual_review'"],
      ["origin_source", "'x'"], ["operation", "'x'"], ["product_model", "'x'"],
    ]) {
      await expect(db.query(`update public.lead_assignments set ${col}=${val} where id=$1`, [id])).rejects.toThrow(/imut/i);
    }
    const u = await seedRep(db, org, "Márcio", 2);
    await db.query(
      `update public.lead_assignments set status='accepted', accepted_at=now(), accepted_via='button', first_human_message_at=now(),
         first_human_message_by=$2, sla_breached=true, redistribution_reason='x', resolved_at=now(), resolved_by=$2, resolution='ok' where id=$1`,
      [id, u.userId]);
  });
});

describe("lead_distribution_shadow_log FKs", () => {
  it("apagar conversa/handoff remove a linha do log", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const h = await seedHandoff(db, org);
    await db.query(
      `insert into public.lead_distribution_shadow_log(organization_id,handoff_event_id,conversation_id,contact_id,would_rep_id,reason,pointer_before,pointer_after,handed_at)
       values ($1,$2,$3,$4,$5,'round_robin',0,1,now())`, [org, h.handoffId, h.conversationId, h.contactId, a.repId]);
    await db.query("delete from public.handoff_events where id=$1", [h.handoffId]);
    await db.query("delete from public.conversations where id=$1", [h.conversationId]);
    expect((await db.query("select 1 from public.lead_distribution_shadow_log")).rows).toHaveLength(0);
  });
});
