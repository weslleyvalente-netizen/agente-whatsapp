// Autor da mensagem do painel (metadata.sent_by_user_id) nas regras de SLA: mensagem de outra pessoa não protege nem encerra a espera do vendedor.
// Autoria desconhecida (celular da loja e registros antigos, sem a chave) continua contando como antes.
import { beforeEach, describe, expect, it } from "vitest";
import { inMinutes } from "./harness.js";
import { ALL_ON, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => { ({ db, q } = await setupHandoffDb()); });

const ON = { ...ALL_ON, sla_alert_escalation_enabled: true };
const THREE: Array<[string, number, string?]> = [["Marina", 1], ["Márcio", 2], ["Paulo", 3]];
type World = Awaited<ReturnType<typeof seedWorld>>;
const row = async (id: string) => (await q("select * from public.lead_assignments where id=$1", [id]))[0];
const escalate = async (id: string) => (await q("select public.escalate_alert_assignment($1,$2,$3) as id", [id, inMinutes(-5), inMinutes(60)]))[0].id as string | null;
const awaiting = async (id: string) => (await q("select public._awaiting_first_response(x) as w from public.lead_assignments x where x.id=$1", [id]))[0].w as boolean;
const answered = async (id: string) => (await q("select public._alert_assignment_answered(x) as a from public.lead_assignments x where x.id=$1", [id]))[0].a as boolean;

/** Cliente da carteira da Marina (existing_owner, 'alert'), SLA vencido; atribuição recuada para as mensagens virem depois dela. */
async function carteira() {
  const w = await seedWorld(db, ON, THREE);
  const h = await seedLead(db, w.org, { assignedTo: w.reps["Marina"].userId, handedAt: inMinutes(-130) });
  const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(-70)]))[0].id as string;
  await q("alter table public.lead_assignments disable trigger lead_assignments_guard_update");
  await q("update public.lead_assignments set assigned_at = assigned_at - interval '60 minutes' where id=$1", [id]);
  await q("alter table public.lead_assignments enable trigger lead_assignments_guard_update");
  return { w, h, id, marina: w.reps["Marina"].userId };
}
/** Mensagem humana; `author`: usuário do painel, null = celular da loja / registro antigo (sem a chave). */
async function send(w: World, conv: string, author: string | null, o: { confirmed?: boolean; failed?: boolean; at?: number; badKey?: boolean } = {}) {
  const meta: Record<string, unknown> = {};
  if (author) meta.sent_by_user_id = author;
  if (o.badKey) meta.sent_by_user_id = "nao-e-uuid";
  if (o.failed) meta.send_failed_at = "2026-11-19T12:00:00Z";
  return (await q("insert into public.messages(organization_id,conversation_id,role,content,evolution_message_id,metadata,created_at) values ($1,$2,'human_agent','oi',$3,$4::jsonb,$5) returning id",
    [w.org, conv, o.confirmed === false ? null : "wa-" + Math.random().toString(36).slice(2), JSON.stringify(meta), inMinutes(o.at ?? -1)]))[0].id as string;
}
const panelRecord = (w: World, conv: string, author: string) => q("select public.record_human_message($1,$2,now(),$3,'panel')", [w.org, conv, author]);

describe("#110: quem escreveu a mensagem decide se ela protege o vendedor", () => {
  it("mensagem do GESTOR (autor conhecido) durante o período da Marina NÃO a protege: a escalada troca", async () => {
    const { w, h, id } = await carteira();
    await send(w, h.conversationId, w.def);
    await panelRecord(w, h.conversationId, w.def); // marco: autor = gestor
    expect(await answered(id)).toBe(false);
    expect(await q("select id from public.list_escalation_candidates(50) where id=$1", [id])).toHaveLength(1);
    expect(await escalate(id)).toBeTruthy();
  });

  it("mensagem da própria MARINA (autor = ela) protege", async () => {
    const { w, h, id, marina } = await carteira();
    await send(w, h.conversationId, marina);
    expect(await answered(id)).toBe(true);
    expect(await escalate(id)).toBeNull();
  });

  it("AUTORIA DESCONHECIDA (celular da loja / registro antigo, sem a chave) continua protegendo, como antes", async () => {
    const { w, h, id } = await carteira();
    await send(w, h.conversationId, null);
    expect(await answered(id)).toBe(true);
    expect(await escalate(id)).toBeNull();
  });

  it("registro antigo: marco do gestor (first_human_message_by = gestor) sem mensagem com autor também não protege", async () => {
    const { w, h, id } = await carteira();
    await panelRecord(w, h.conversationId, w.def); // marco do gestor, nenhuma mensagem gravada
    expect(await answered(id)).toBe(false);
  });

  it("chave inválida (não é uuid) é tratada como desconhecida, nunca derruba a regra", async () => {
    const { w, h, id } = await carteira();
    await send(w, h.conversationId, null, { badKey: true });
    expect(await answered(id)).toBe(true);
  });

  it("gestor E vendedor: a mensagem da Marina protege mesmo havendo a do gestor", async () => {
    const { w, h, id, marina } = await carteira();
    await send(w, h.conversationId, w.def, { at: -10 });
    await send(w, h.conversationId, marina, { at: -5 });
    expect(await answered(id)).toBe(true);
  });

  it("mensagem do gestor EM VOO não adia a troca; a do vendedor em voo adia", async () => {
    const a = await carteira();
    await send(a.w, a.h.conversationId, a.w.def, { confirmed: false, at: -2 });
    expect(await escalate(a.id)).toBeTruthy();
    ({ db, q } = await setupHandoffDb());
    const b = await carteira();
    await send(b.w, b.h.conversationId, b.marina, { confirmed: false, at: -2 });
    expect(await escalate(b.id)).toBeNull();
  });

  it("devolução manual: o atendimento anterior só prova se o autor foi o próprio vendedor (ou desconhecido)", async () => {
    for (const [author, protegido] of [["MARCIO", true], ["GESTOR", false], [null, true]] as const) {
      ({ db, q } = await setupHandoffDb());
      const w = await seedWorld(db, ON, THREE);
      const h = await seedLead(db, w.org, { assignedTo: w.reps["Márcio"].userId, handedAt: inMinutes(-300) });
      const first = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(60)]))[0].id as string;
      const who = author === "MARCIO" ? w.reps["Márcio"].userId : author === "GESTOR" ? w.def : null;
      await send(w, h.conversationId, who, { at: 0 });
      // o marco registra o autor da 1ª mensagem; eco do celular (null) vira phone_echo
      if (who) await panelRecord(w, h.conversationId, who); else await q("select public.record_human_message($1,$2,now(),null,'phone_echo')", [w.org, h.conversationId]);
      await q("select public.manual_assign($1,$2,$3,$4,$5)", [w.org, h.conversationId, w.reps["Marina"].repId, w.def, inMinutes(60)]);
      const ret = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [w.org, h.conversationId, w.reps["Márcio"].repId, w.def, inMinutes(-70)]))[0].id as string;
      expect(await escalate(ret) === null).toBe(protegido);
      void first;
    }
  });
});

describe("#111: Assumir, e quem encerra a espera da primeira resposta", () => {
  it("assumiu e o GESTOR respondeu: a cobrança continua; só a resposta da própria Marina encerra", async () => {
    const { w, h, id, marina } = await carteira();
    await q("select public.accept_assignment($1,$2,false)", [id, marina]);
    await send(w, h.conversationId, w.def);
    expect(await awaiting(id)).toBe(true);
    expect((await q("select public.flag_sla_alerts() as n"))[0].n).toBeGreaterThanOrEqual(1);
    await send(w, h.conversationId, marina);
    expect(await awaiting(id)).toBe(false);
    expect(await escalate(id)).toBeNull();
  });

  it("assumiu e o gestor respondeu, ninguém mais: a escalada ainda troca", async () => {
    const { w, h, id, marina } = await carteira();
    await q("select public.accept_assignment($1,$2,false)", [id, marina]);
    await send(w, h.conversationId, w.def);
    expect(await escalate(id)).toBeTruthy();
  });

  it("rodízio: assumiu, o gestor respondeu: redistribui; a Marina respondeu: não", async () => {
    for (const [autor, redistribui] of [["GESTOR", true], ["MARINA", false]] as const) {
      ({ db, q } = await setupHandoffDb());
      const w = await seedWorld(db, ON, THREE);
      const h = await seedLead(db, w.org, { handedAt: inMinutes(-130) });
      const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(-70)]))[0].id as string;
      await q("alter table public.lead_assignments disable trigger lead_assignments_guard_update");
      await q("update public.lead_assignments set assigned_at = assigned_at - interval '60 minutes' where id=$1", [id]);
      await q("alter table public.lead_assignments enable trigger lead_assignments_guard_update");
      await q("select public.accept_assignment($1,$2,false)", [id, w.reps["Marina"].userId]);
      await send(w, h.conversationId, autor === "GESTOR" ? w.def : w.reps["Marina"].userId);
      expect(Boolean((await q("select public.redistribute_assignment($1,$2) as id", [id, inMinutes(60)]))[0].id)).toBe(redistribui);
    }
  });

  it("autoria desconhecida (celular) encerra a espera, como antes", async () => {
    const { w, h, id, marina } = await carteira();
    await q("select public.accept_assignment($1,$2,false)", [id, marina]);
    await send(w, h.conversationId, null);
    expect(await awaiting(id)).toBe(false);
  });
});

describe("função de autoria", () => {
  it("_msg_author devolve o uuid válido e NULL para ausente, nulo ou inválido", async () => {
    const r = await q(`select public._msg_author('{"sent_by_user_id":"11111111-1111-4111-8111-111111111111"}') as a, public._msg_author('{}') as b, public._msg_author(null) as c, public._msg_author('{"sent_by_user_id":"x"}') as d`);
    expect(r[0]).toEqual({ a: "11111111-1111-4111-8111-111111111111", b: null, c: null, d: null });
  });
  it("somente service_role executa", async () => {
    const r = (await q("select has_function_privilege('authenticated','public._msg_author(jsonb)','execute') as a, has_function_privilege('service_role','public._msg_author(jsonb)','execute') as s"))[0];
    expect(r).toEqual({ a: false, s: true });
  });
});
