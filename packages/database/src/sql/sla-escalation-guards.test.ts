// Guardas da escalada: janela de ativação, fila de candidatas, sinais de "já atendido" e reparo do card pulado.
import { beforeEach, describe, expect, it } from "vitest";
import { inMinutes } from "./harness.js";
import { ALL_ON, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => { ({ db, q } = await setupHandoffDb()); });
const ON = { ...ALL_ON, sla_alert_escalation_enabled: true };
const THREE: Array<[string, number, string?]> = [["Marina", 1], ["Márcio", 2], ["Paulo", 3]];

async function lead(w: Awaited<ReturnType<typeof seedWorld>>, dueInMinutes = -70, handedAtMinutes = -130) {
  const h = await seedLead(db, w.org, { assignedTo: w.reps["Marina"].userId, handedAt: inMinutes(handedAtMinutes) });
  const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(dueInMinutes)]))[0].id as string;
  return { ...h, id };
}
const escalate = async (id: string) => (await q("select public.escalate_alert_assignment($1,$2,$3) as id", [id, inMinutes(-1), inMinutes(60)]))[0].id as string | null;
const candidates = async (perOrg = 50) => (await q("select * from public.list_escalation_candidates($1)", [perOrg])).map(r => r.id as string);
const setSettings = (org: string, patch: object) => q("update public.organizations set settings = settings || $2::jsonb where id=$1", [org, JSON.stringify(patch)]);

describe("janela de ativação e idade", () => {
  it("ligar a chave não move carteira antiga: pendente que estourou antes da ativação, ou há mais de 24h, nunca escala", async () => {
    const w = await seedWorld(db, ON, THREE);
    const old = await lead(w, -60 * 30, -60 * 31); // estourou há 30h
    const beforeActivation = await lead(w, -70);
    await setSettings(w.org, { sla_alert_escalation_activated_at: inMinutes(-10) });
    const fresh = await lead(w, -5, -60); // vence DEPOIS da ativação
    for (const l of [old, beforeActivation]) { expect(await escalate(l.id)).toBeNull(); }
    expect(await candidates()).toEqual([fresh.id]);
    expect(await escalate(fresh.id)).toBeTruthy();
    expect((await q("select status from public.lead_assignments where id=$1", [old.id]))[0].status).toBe("pending");
  });

  it("sem timestamp de ativação (ligado por SQL) vale só o teto de 24h", async () => {
    const w = await seedWorld(db, ON, THREE);
    const a = await lead(w, -70); const stale = await lead(w, -60 * 25, -60 * 26);
    expect(await candidates()).toEqual([a.id]);
    expect(await escalate(stale.id)).toBeNull();
  });
});

describe("fila de candidatas", () => {
  it("mais de 100 antigas recusadas + 1 estouro novo: o novo continua na fila e escala", async () => {
    const w = await seedWorld(db, ON, THREE);
    for (let i = 0; i < 110; i++) await lead(w, -60 * 30, -60 * 31);
    const fresh = await lead(w, -70);
    const list = await candidates(50);
    expect(list).toEqual([fresh.id]);
    expect(await escalate(list[0])).toBeTruthy();
  });

  it("limite é por organização e em ordem de vencimento; outra organização sem a chave não aparece", async () => {
    const w = await seedWorld(db, ON, THREE);
    const a = await lead(w, -90, -150); const b = await lead(w, -80); const c = await lead(w, -70);
    const other = await seedWorld(db, ALL_ON, THREE); await lead(other, -70);
    expect(await candidates(2)).toEqual([a.id, b.id]);
    expect((await candidates(10)).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("'sem vendedor' só volta à fila quando surge alguém elegível", async () => {
    const w = await seedWorld(db, ON, [["Marina", 1]]);
    const l = await lead(w);
    expect(await candidates()).toEqual([l.id]);
    expect(await escalate(l.id)).toBeNull(); // deixa o rastro
    expect(await candidates()).toEqual([]);
    const { seedRep } = await import("./harness.js");
    const m = await seedRep(db, w.org, "Márcio", 2); await q("insert into auth.users(id) values ($1)", [m.userId]);
    expect(await candidates()).toEqual([l.id]);
  });

  it("chave desligada: ninguém na fila", async () => {
    const w = await seedWorld(db, ALL_ON, THREE); await lead(w);
    expect(await candidates()).toEqual([]);
  });
});

describe("sinais de 'já atendido' (a função recusa e a fila não lista)", () => {
  const cases: Array<[string, (w: any, l: any) => Promise<unknown>]> = [
    ["ligação registrada depois da atribuição", (w, l) => q("insert into public.sales_call_logs(organization_id,opportunity_id,contact_id) select $1,id,$2 from public.opportunities where contact_id=$2", [w.org, l.contactId])],
    ["atividade comercial do negócio depois da atribuição", (_w, l) => q("update public.opportunities set last_commercial_activity_at=now() where contact_id=$1", [l.contactId])],
    ["conversa fechada", (_w, l) => q("update public.conversations set status='closed' where id=$1", [l.conversationId])],
    ["negócio ganho", (_w, l) => q("update public.opportunities set status='won', updated_at=now() where contact_id=$1", [l.contactId])],
    ["negócio perdido", (_w, l) => q("update public.opportunities set status='lost', updated_at=now() where contact_id=$1", [l.contactId])],
    ["aceite registrado", (_w, l) => q("update public.lead_assignments set accepted_at=now() where id=$1", [l.id])],
    ["primeira resposta humana registrada", (_w, l) => q("update public.lead_assignments set first_human_message_at=now() where id=$1", [l.id])],
    ["mensagem humana depois do handoff", (w, l) => q("insert into public.messages(organization_id,conversation_id,role,content,created_at) values ($1,$2,'human_agent','oi',$3)", [w.org, l.conversationId, inMinutes(-30)])],
  ];
  for (const [name, act] of cases) {
    it(name, async () => {
      const w = await seedWorld(db, ON, THREE);
      const l = await lead(w);
      expect(await candidates()).toEqual([l.id]);
      await act(w, l);
      expect(await escalate(l.id)).toBeNull();
      expect(await candidates()).toEqual([]);
      expect((await q("select status from public.lead_assignments where id=$1", [l.id]))[0].status).toBe("pending");
    });
  }

  it("ligação ANTERIOR à atribuição não conta como atendimento", async () => {
    const w = await seedWorld(db, ON, THREE);
    const l = await lead(w);
    await q("insert into public.sales_call_logs(organization_id,opportunity_id,contact_id,called_at) select $1,id,$2,now() - interval '3 days' from public.opportunities where contact_id=$2", [w.org, l.contactId]);
    expect(await escalate(l.id)).toBeTruthy();
  });

  it("manual: resposta do vendedor ANTERIOR (antes da reatribuição) não bloqueia a escalada do novo", async () => {
    const w2 = await seedWorld(db, ON, THREE);
    const l2 = await lead(w2, 60, -130);
    await q("insert into public.messages(organization_id,conversation_id,role,content,created_at) values ($1,$2,'human_agent','oi',$3)", [w2.org, l2.conversationId, inMinutes(-100)]);
    const manual = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [w2.org, l2.conversationId, w2.reps["Márcio"].repId, w2.def, inMinutes(-70)]))[0].id;
    expect(await escalate(manual)).toBeTruthy();
  });
});

describe("ensure_handoff_cards (reparo do card pulado)", () => {
  async function skipped() {
    const w = await seedWorld(db, { lead_distribution_enabled: true }, THREE); // pipeline desligado: a atribuição nasce sem card
    const l = await lead(w, 60);
    expect((await q("select opportunity_id from public.lead_assignments where id=$1", [l.id]))[0].opportunity_id).toBeNull();
    return { w, l };
  }
  it("cria o card faltante para o vendedor da atribuição, uma única vez", async () => {
    const { w, l } = await skipped();
    expect((await q("select public.ensure_handoff_cards(50) as n"))[0].n).toBe(0); // chave do pipeline ainda desligada
    await setSettings(w.org, { sales_auto_pipeline_enabled: true });
    expect((await q("select public.ensure_handoff_cards(50) as n"))[0].n).toBe(1);
    expect((await q("select public.ensure_handoff_cards(50) as n"))[0].n).toBe(0);
    const opps = await q("select owner_id, stage, status from public.opportunities where contact_id=$1", [l.contactId]);
    expect(opps).toEqual([{ owner_id: w.reps["Marina"].userId, stage: "interest_received", status: "open" }]);
  });
  it("não cria para contato que já tem negócio (inclusive fechado), atribuição antiga ou limite 0 excedido", async () => {
    const { w, l } = await skipped();
    await setSettings(w.org, { sales_auto_pipeline_enabled: true });
    await q("insert into public.opportunities(organization_id,contact_id,operation,initial_operation,stage,status) values ($1,$2,'consortium','consortium','membership','won')", [w.org, l.contactId]);
    expect((await q("select public.ensure_handoff_cards(50) as n"))[0].n).toBe(0);
    const s2 = await skipped(); await setSettings(s2.w.org, { sales_auto_pipeline_enabled: true });
    await q("alter table public.lead_assignments disable trigger lead_assignments_guard_update");
    await q("update public.lead_assignments set created_at = now() - interval '30 hours' where id=$1", [s2.l.id]);
    await q("alter table public.lead_assignments enable trigger lead_assignments_guard_update");
    expect((await q("select public.ensure_handoff_cards(50) as n"))[0].n).toBe(0);
  });
  it("somente service_role executa as funções novas", async () => {
    const r = await q("select has_function_privilege('authenticated','public.list_escalation_candidates(integer)','execute') as a, has_function_privilege('authenticated','public.ensure_handoff_cards(integer)','execute') as b, has_function_privilege('service_role','public.ensure_handoff_cards(integer)','execute') as c");
    expect(r[0]).toEqual({ a: false, b: false, c: true });
  });
});
