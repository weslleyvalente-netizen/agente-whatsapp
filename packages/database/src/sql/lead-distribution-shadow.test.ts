import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(); });

const shadow = async (org: string, h: { conversationId: string; handoffId: string }) =>
  (await db.query<{ id: string | null }>("select public.distribute_lead_shadow($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, inMinutes(15)])).rows[0].id;
const log = async (id: string) => (await db.query<any>("select * from public.lead_distribution_shadow_log where id=$1", [id])).rows[0];
const SHADOW = { lead_distribution_shadow_enabled: true };

describe("distribute_lead_shadow", () => {
  it("registra quem receberia, alternando Marina → Márcio → Marina, sem alterar nada real", async () => {
    const org = await seedOrg(db, SHADOW); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const names: string[] = [];
    const handoffs = [];
    for (let i = 0; i < 3; i++) { const h = await seedHandoff(db, org); handoffs.push(h); names.push((await log((await shadow(org, h))!)).would_rep_name); }
    expect(names).toEqual(["Marina", "Márcio", "Marina"]);
    // nada real foi tocado
    expect((await db.query<any>("select count(*)::int as n from public.lead_assignments")).rows[0].n).toBe(0);
    expect((await db.query<any>("select count(*)::int as n from public.conversations where assigned_to is not null")).rows[0].n).toBe(0);
    const st = (await db.query<any>("select last_rotation_order, shadow_last_rotation_order from public.lead_distribution_state")).rows[0];
    expect(st).toEqual({ last_rotation_order: 0, shadow_last_rotation_order: 1 });
    expect((await db.query<any>("select count(*)::int as n from public.sales_reps where last_assigned_at is not null")).rows[0].n).toBe(0);
  });

  it("não toca conversa, negócio nem tarefas", async () => {
    const org = await seedOrg(db, SHADOW); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    const opp = (await db.query<any>("insert into public.opportunities(organization_id,contact_id) values ($1,$2) returning id", [org, h.contactId])).rows[0].id;
    await db.query("insert into public.tasks(organization_id,contact_id,status) values ($1,$2,'pending')", [org, h.contactId]);
    await shadow(org, h);
    expect((await db.query<any>("select owner_id, owner_assigned_at from public.opportunities where id=$1", [opp])).rows[0]).toEqual({ owner_id: null, owner_assigned_at: null });
    expect((await db.query<any>("select assignee_id from public.tasks")).rows[0].assignee_id).toBeNull();
    expect((await db.query<any>("select assigned_to, assigned_at from public.conversations where id=$1", [h.conversationId])).rows[0]).toEqual({ assigned_to: null, assigned_at: null });
  });

  it("usa a mesma decisão da real: dono existente, pausado, exceção e prazo registrado", async () => {
    const org = await seedOrg(db, SHADOW); await seedRep(db, org, "Marina", 1, "paused"); const marcio = await seedRep(db, org, "Márcio", 2);
    const owned = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, owned.contactId, marcio.userId]);
    expect(await log((await shadow(org, owned))!)).toMatchObject({ would_rep_name: "Márcio", reason: "existing_owner", sla_action: "alert" });
    expect(await log((await shadow(org, await seedHandoff(db, org)))!)).toMatchObject({ would_rep_name: "Márcio", reason: "round_robin", sla_action: "redistribute", pointer_before: 0, pointer_after: 2 });
    await db.query("update public.sales_reps set availability='paused'");
    expect(await log((await shadow(org, await seedHandoff(db, org)))!)).toMatchObject({ would_rep_id: null, reason: "exception", exception_reason: "no_available_rep" });
    expect((await log((await shadow(org, await seedHandoff(db, org)))!)).sla_due_at).not.toBeNull();
  });

  it("é idempotente por handoff", async () => {
    const org = await seedOrg(db, SHADOW); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    expect(await shadow(org, h)).toBe(await shadow(org, h));
    expect((await db.query<any>("select shadow_last_rotation_order from public.lead_distribution_state")).rows[0].shadow_last_rotation_order).toBe(1);
  });

  it("não faz nada com o modo sombra desligado nem com a distribuição real ligada", async () => {
    const off = await seedOrg(db, {}); await seedRep(db, off, "Marina", 1);
    expect(await shadow(off, await seedHandoff(db, off))).toBeNull();
    const live = await seedOrg(db, { lead_distribution_enabled: true, lead_distribution_shadow_enabled: true }); await seedRep(db, live, "Marina", 1);
    expect(await shadow(live, await seedHandoff(db, live))).toBeNull();
    expect((await db.query<any>("select count(*)::int as n from public.lead_distribution_shadow_log")).rows[0].n).toBe(0);
  });
});
