// Assumir não encerra o prazo da primeira resposta: só mensagem humana confirmada e sem falha encerra a espera.
// Roteamento pelo último responsável e selo "assumido" (status 'accepted') continuam como antes.
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
const escalate = async (id: string, escalateInMinutes = -5) =>
  (await q("select public.escalate_alert_assignment($1,$2,$3) as id", [id, inMinutes(escalateInMinutes), inMinutes(60)]))[0].id as string | null;
const accept = async (id: string, userId: string, admin = false) => (await q("select public.accept_assignment($1,$2,$3) as ok", [id, userId, admin]))[0].ok as boolean;
const awaiting = async (id: string) => (await q("select public._awaiting_first_response(x) as w from public.lead_assignments x where x.id=$1", [id]))[0].w as boolean;
const candidates = async (id: string) => (await q("select id from public.list_escalation_candidates(50) where id=$1", [id])).length;
const flag = async () => (await q("select public.flag_sla_alerts() as n"))[0].n as number;

/** Cliente da carteira do Márcio (existing_owner, 'alert') com o SLA já vencido. */
async function carteira() {
  const w = await seedWorld(db, ON, THREE);
  const h = await seedLead(db, w.org, { assignedTo: w.reps["Márcio"].userId, handedAt: inMinutes(-130) });
  const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(-70)]))[0].id as string;
  expect(await row(id)).toMatchObject({ reason: "existing_owner", sla_action: "alert", status: "pending", awaiting_first_response: false });
  return { w, h, id, marcio: w.reps["Márcio"].userId };
}
/** Lead novo do rodízio ('redistribute'): vai à Marina (1ª na ordem) com o SLA vencido. */
async function rodizio() {
  const w = await seedWorld(db, ON, THREE);
  const h = await seedLead(db, w.org, { handedAt: inMinutes(-130) });
  const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(-70)]))[0].id as string;
  expect(await row(id)).toMatchObject({ reason: "round_robin", sla_action: "redistribute", status: "pending", rep_id: w.reps["Marina"].repId });
  return { w, h, id, marina: w.reps["Marina"].userId };
}
const msg = async (w: World, conv: string, o: { id?: string | null; failed?: boolean; at?: number } = {}) =>
  (await q("insert into public.messages(organization_id,conversation_id,role,content,evolution_message_id,metadata,created_at) values ($1,$2,'human_agent','Oi, tudo bem?',$3,$4::jsonb,$5) returning id",
    [w.org, conv, o.id === undefined ? "wa-" + Math.random().toString(36).slice(2) : o.id, JSON.stringify(o.failed ? { send_failed_at: new Date().toISOString() } : {}), inMinutes(o.at ?? 0)]))[0].id as string;
const fail = (messageId: string) => q("update public.messages set metadata = coalesce(metadata,'{}'::jsonb) || '{\"send_failed_at\":\"2026-11-19T12:00:00Z\"}' where id=$1", [messageId]);
const confirm = (messageId: string) => q("update public.messages set evolution_message_id='wa-ok' where id=$1", [messageId]);
const panelReply = (w: World, conv: string, userId: string) => q("select public.record_human_message($1,$2,now(),$3,'panel')", [w.org, conv, userId]);

describe("Assumir mantém o acompanhamento da primeira resposta", () => {
  it("assumir sem responder (carteira): continua 'accepted' (selo e roteamento), mas o SLA cobra e a escalada ainda troca quem nunca atendeu", async () => {
    const { w, h, id, marcio } = await carteira();
    const before = await row(id);
    expect(await accept(id, marcio)).toBe(true);
    const a = await row(id);
    // o que o clique sempre fez
    expect(a).toMatchObject({ status: "accepted", accepted_via: "button" });
    expect(a.accepted_at).toBeTruthy();
    // o prazo é o mesmo (sla_due_at imutável) e agora a atribuição ainda espera a primeira resposta
    expect(new Date(a.sla_due_at).getTime()).toBe(new Date(before.sla_due_at).getTime());
    expect(a.awaiting_first_response).toBe(true);
    expect(await awaiting(id)).toBe(true);
    // cobrança: o alerta marca o atraso mesmo depois do clique
    expect(await flag()).toBeGreaterThanOrEqual(1);
    expect((await row(id)).sla_breached).toBe(true);
    // e, como ninguém atendeu, aos 2x o SLA o cliente passa ao próximo vendedor, uma única vez
    expect(await candidates(id)).toBe(1);
    const nid = await escalate(id);
    expect(nid).toBeTruthy();
    expect(await row(id)).toMatchObject({ status: "redistributed", redistribution_reason: "sla_escalation" });
    expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).not.toBe(marcio);
    expect(await escalate(nid!)).toBeNull(); // no máximo uma escalada por cadeia
    void w;
  });

  it("roteamento pelo último responsável e selo 'assumido' preservados: novo encaminhamento volta ao vendedor que assumiu", async () => {
    const { w, h, id, marcio } = await carteira();
    await accept(id, marcio);
    // sem dono na conversa: só o "último responsável" (atribuição aceita) pode apontar o Márcio
    await q("update public.conversations set assigned_to=null where id=$1", [h.conversationId]);
    const ho2 = (await q("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,now()) returning id", [w.org, h.conversationId]))[0].id;
    const nid = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, ho2, inMinutes(60)]))[0].id as string;
    expect(await row(nid)).toMatchObject({ reason: "existing_owner", rep_id: w.reps["Márcio"].repId });
    expect((await row(id)).status).toBe("redistributed"); // encerrada pelo novo encaminhamento, como sempre
  });

  it("responder sem clicar: a 1ª mensagem do painel assume o lead e a espera só acaba quando a mensagem é confirmada", async () => {
    const { w, h, id, marcio } = await carteira();
    const m = await msg(w, h.conversationId, { id: null }); // salva, ainda sem id do WhatsApp (em voo)
    await panelReply(w, h.conversationId, marcio);
    expect(await row(id)).toMatchObject({ status: "accepted", accepted_via: "first_message", awaiting_first_response: true });
    // em voo: não troca e não cobra
    expect(await awaiting(id)).toBe(false);
    expect(await escalate(id)).toBeNull();
    // confirmada: encerrada
    await confirm(m);
    expect(await awaiting(id)).toBe(false);
    expect(await flag()).toBe(0);
    expect(await escalate(id)).toBeNull();
    expect(await candidates(id)).toBe(0);
  });

  it("responder sem clicar, mas o envio FALHOU: a espera continua (cobrança e escalada voltam)", async () => {
    const { w, h, id, marcio } = await carteira();
    const m = await msg(w, h.conversationId, { id: null });
    await panelReply(w, h.conversationId, marcio);
    await fail(m);
    expect(await awaiting(id)).toBe(true);
    expect(await flag()).toBeGreaterThanOrEqual(1);
    expect(await escalate(id)).toBeTruthy();
  });

  it("clicar duas vezes: o segundo clique não muda nada (idempotente), nem por admin", async () => {
    const { id, marcio, w } = await carteira();
    expect(await accept(id, marcio)).toBe(true);
    const first = await row(id);
    expect(await accept(id, marcio)).toBe(false);
    expect(await accept(id, w.def, true)).toBe(false);
    const second = await row(id);
    expect(second).toMatchObject({ status: "accepted", accepted_via: "button", awaiting_first_response: true });
    expect(new Date(second.accepted_at).getTime()).toBe(new Date(first.accepted_at).getTime());
    expect((await q("select count(*)::int as n from public.lead_assignments where conversation_id=$1", [first.conversation_id]))[0].n).toBe(1);
    expect(await awaiting(id)).toBe(true);
  });

  it("outro vendedor não pode assumir pelo Márcio; admin pode e fica registrado como 'admin' (também continua aguardando)", async () => {
    const { id, w } = await carteira();
    await expect(accept(id, w.reps["Marina"].userId)).rejects.toThrow(/Somente o vendedor atribuído/);
    expect(await accept(id, w.def, true)).toBe(true);
    expect(await row(id)).toMatchObject({ accepted_via: "admin", awaiting_first_response: true });
    expect(await awaiting(id)).toBe(true);
  });

  it("assumir e depois responder: mensagem confirmada encerra a espera; com falha, não", async () => {
    const ok = await carteira();
    await accept(ok.id, ok.marcio);
    await msg(ok.w, ok.h.conversationId);
    await panelReply(ok.w, ok.h.conversationId, ok.marcio);
    expect(await awaiting(ok.id)).toBe(false);
    expect(await flag()).toBe(0);
    expect(await escalate(ok.id)).toBeNull();

    const bad = await carteira();
    await accept(bad.id, bad.marcio);
    const m = await msg(bad.w, bad.h.conversationId, { id: null });
    await panelReply(bad.w, bad.h.conversationId, bad.marcio);
    await fail(m);
    expect(await awaiting(bad.id)).toBe(true);
    expect(await escalate(bad.id)).toBeTruthy();
  });

  it("corrida: resposta antes da escalada protege o vendedor", async () => {
    const { w, h, id, marcio } = await carteira();
    await accept(id, marcio);
    await msg(w, h.conversationId);
    await panelReply(w, h.conversationId, marcio);
    expect(await escalate(id)).toBeNull();
    expect((await row(id)).status).toBe("accepted");
    expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).toBe(marcio);
  });

  it("corrida: escalada primeiro e resposta tardia depois => uma única troca, sem duplicar nem voltar", async () => {
    const { w, h, id, marcio } = await carteira();
    await accept(id, marcio);
    const before = (await q("select count(*)::int as n from public.lead_assignments where conversation_id=$1", [h.conversationId]))[0].n;
    const nid = await escalate(id);
    expect(nid).toBeTruthy();
    // a resposta (feita no instante da troca) chega com horário anterior à nova atribuição
    await msg(w, h.conversationId, { at: -1 });
    await q("select public.record_human_message($1,$2,$3,$4,'panel')", [w.org, h.conversationId, inMinutes(-1), marcio]);
    expect((await q("select count(*)::int as n from public.lead_assignments where conversation_id=$1", [h.conversationId]))[0].n).toBe(before + 1);
    expect(await row(nid!)).toMatchObject({ status: "pending", first_human_message_at: null, reason: "sla_redistribution" });
    expect(await escalate(id)).toBeNull(); // a antiga já foi escalada
    expect(await escalate(nid!)).toBeNull(); // no máximo uma por cadeia
  });

  it("corrida: mensagem em voo no instante da escalada adia a troca; se falhar, a troca acontece na varredura seguinte", async () => {
    const { w, h, id, marcio } = await carteira();
    await accept(id, marcio);
    const m = await msg(w, h.conversationId, { id: null }); // o vendedor acabou de enviar; o worker ainda não confirmou
    expect(await escalate(id)).toBeNull();
    expect((await row(id)).status).toBe("accepted");
    await fail(m);
    expect(await escalate(id)).toBeTruthy();
  });

  it("depois de atendimento comprovado, novo atraso gera cobrança e MANTÉM o responsável (com ou sem clique)", async () => {
    for (const clicou of [true, false]) {
      ({ db, q } = await setupHandoffDb());
      const { w, h, id, marcio } = await carteira();
      if (clicou) await accept(id, marcio);
      await msg(w, h.conversationId);
      await panelReply(w, h.conversationId, marcio);
      // o cliente volta: novo encaminhamento da IA e o prazo novo já vence sem resposta
      const ho2 = (await q("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [w.org, h.conversationId, inMinutes(-100)]))[0].id;
      const nid = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, ho2, inMinutes(-70)]))[0].id as string;
      expect(await row(nid)).toMatchObject({ reason: "existing_owner", rep_id: w.reps["Márcio"].repId, status: "pending", sla_action: "alert" });
      expect(await flag()).toBeGreaterThanOrEqual(1);
      expect((await row(nid)).sla_breached).toBe(true); // cobrança: alerta + push "SLA estourado" + quadro de atraso
      expect(await escalate(nid)).toBeNull();           // mas o cliente fica com quem o atendeu
      expect(await candidates(nid)).toBe(0);
      expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).toBe(marcio);
    }
  });

  it("rodízio (lead novo): assumir sem responder continua redistribuindo no prazo; resposta confirmada impede", async () => {
    const sem = await rodizio();
    await accept(sem.id, sem.marina);
    expect(await row(sem.id)).toMatchObject({ status: "accepted", awaiting_first_response: true });
    const nid = (await q("select public.redistribute_assignment($1,$2) as id", [sem.id, inMinutes(60)]))[0].id as string;
    expect(nid).toBeTruthy();
    expect(await row(sem.id)).toMatchObject({ status: "expired", redistribution_reason: "sla_expired" });
    expect((await row(nid)).rep_id).toBe(sem.w.reps["Márcio"].repId);

    ({ db, q } = await setupHandoffDb());
    const com = await rodizio();
    await accept(com.id, com.marina);
    await msg(com.w, com.h.conversationId);
    await panelReply(com.w, com.h.conversationId, com.marina);
    expect((await q("select public.redistribute_assignment($1,$2) as id", [com.id, inMinutes(60)]))[0].id).toBeNull();
    expect((await row(com.id)).status).toBe("accepted");
  });

  it("rodízio: resposta pelo painel SEM clicar nunca foi redistribuída (aceita na 1ª mensagem) e continua assim quando confirmada; com falha, volta a valer", async () => {
    const ok = await rodizio();
    const m = await msg(ok.w, ok.h.conversationId, { id: null });
    await panelReply(ok.w, ok.h.conversationId, ok.marina);
    await confirm(m);
    expect((await q("select public.redistribute_assignment($1,$2) as id", [ok.id, inMinutes(60)]))[0].id).toBeNull();

    ({ db, q } = await setupHandoffDb());
    const bad = await rodizio();
    const mf = await msg(bad.w, bad.h.conversationId, { id: null });
    await panelReply(bad.w, bad.h.conversationId, bad.marina);
    await fail(mf);
    expect((await q("select public.redistribute_assignment($1,$2) as id", [bad.id, inMinutes(60)]))[0].id).toBeTruthy();
  });

  it("atribuições aceitas ANTES da migração (awaiting_first_response=false) não são cobradas nem movidas", async () => {
    const { id, marcio } = await carteira();
    await accept(id, marcio);
    await q("update public.lead_assignments set awaiting_first_response=false where id=$1", [id]); // como uma linha antiga
    expect(await awaiting(id)).toBe(false);
    expect(await flag()).toBe(0);
    expect(await escalate(id)).toBeNull();
    expect(await candidates(id)).toBe(0);
    const r = await rodizio();
    await accept(r.id, r.marina);
    await q("update public.lead_assignments set awaiting_first_response=false where id=$1", [r.id]);
    expect((await q("select public.redistribute_assignment($1,$2) as id", [r.id, inMinutes(60)]))[0].id).toBeNull();
  });

  it("sem outro vendedor para receber: a atribuição assumida fica com o dono, com rastro, e só cobra", async () => {
    const w = await seedWorld(db, ON, [["Márcio", 1]]);
    const h = await seedLead(db, w.org, { assignedTo: w.reps["Márcio"].userId, handedAt: inMinutes(-130) });
    const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(-70)]))[0].id as string;
    await accept(id, w.reps["Márcio"].userId);
    expect(await escalate(id)).toBeNull();
    expect(await row(id)).toMatchObject({ status: "accepted", redistribution_reason: "sla_escalation_no_rep", sla_breached: true });
  });

  it("somente service_role executa as funções novas", async () => {
    for (const fn of ["public._awaiting_first_response(public.lead_assignments)", "public._human_msg_confirmed(uuid,uuid,timestamptz,uuid)", "public.accept_assignment(uuid,uuid,boolean)", "public.flag_sla_alerts()"]) {
      const r = (await q(`select has_function_privilege('authenticated','${fn}','execute') as a, has_function_privilege('anon','${fn}','execute') as n, has_function_privilege('service_role','${fn}','execute') as s`))[0];
      expect(r).toEqual({ a: false, n: false, s: true });
    }
  });
});

// JANELA DE ENVIO (10 min): quanto uma tentativa de envio pode adiar a decisão, e o que acontece quando ela não sai.
describe("janela de envio: envio lento, falha tardia, mensagem presa e concorrência", () => {
  /** Na vida real a atribuição é mais antiga que o envio: recua assigned_at (a trava de imutabilidade é desligada SÓ no teste). */
  const backdate = async (id: string, minutes = 60) => {
    await q("alter table public.lead_assignments disable trigger lead_assignments_guard_update");
    await q("update public.lead_assignments set assigned_at = assigned_at - make_interval(mins => $2) where id=$1", [id, minutes]);
    await q("alter table public.lead_assignments enable trigger lead_assignments_guard_update");
  };
  /** Vendedor assume, pede o envio (mensagem criada `ageMin` minutos atrás, sem id) e o pedido é registrado AGORA (atividade gravada tarde). */
  async function pedido(ageMin: number, activityDelayMin = 0) {
    const c = await carteira();
    await backdate(c.id);
    await accept(c.id, c.marcio);
    const m = await msg(c.w, c.h.conversationId, { id: null, at: -ageMin });
    await panelReply(c.w, c.h.conversationId, c.marcio); // marco do pedido de envio
    // a atividade comercial é gravada no pedido de envio: normalmente junto da criação da mensagem; em anexo/áudio lento, minutos depois
    await q("update public.opportunities set last_commercial_activity_at = $2 where contact_id=$1", [c.h.contactId, inMinutes(-ageMin + activityDelayMin)]);
    return { ...c, m };
  }

  it("envio LENTO (3 min sem id): adia a troca; quando confirma, encerra a espera", async () => {
    const { id, m } = await pedido(3);
    expect(await escalate(id)).toBeNull();
    expect(await awaiting(id)).toBe(false);
    await confirm(m);
    expect(await escalate(id)).toBeNull();
    expect(await flag()).toBe(0);
  });

  it("envio LENTO que depois FALHA (anexo/áudio: pedido registrado 6 min depois da criação): a atividade tardia não vale e a cobrança volta", async () => {
    const { id, m } = await pedido(6, 5); // pedido registrado 5 min depois da criação: o heurístico antigo (1 min) trataria a atividade como atendimento
    expect(await escalate(id)).toBeNull(); // ainda em voo (6 min < 10)
    await fail(m);
    expect(await awaiting(id)).toBe(true);
    expect(await flag()).toBeGreaterThanOrEqual(1);
    expect(await candidates(id)).toBe(1);
    expect(await escalate(id)).toBeTruthy();
  });

  it("FALHA depois de mais de um minuto: volta à cobrança na varredura seguinte (não precisa ser imediata)", async () => {
    const { id, m } = await pedido(2);
    expect(await escalate(id)).toBeNull();      // varredura 1: em voo
    expect(await flag()).toBe(0);
    await fail(m);                               // o worker esgota as tentativas e marca a falha
    expect(await flag()).toBeGreaterThanOrEqual(1); // varredura 2: cobra
    expect(await escalate(id)).toBeTruthy();
  });

  it("mensagem PRESA (sem id e sem falha há mais de 10 min): o adiamento é limitado; passa a cobrar e a escalar", async () => {
    const { id } = await pedido(11);
    expect(await awaiting(id)).toBe(true);
    expect(await flag()).toBeGreaterThanOrEqual(1);
    expect(await escalate(id)).toBeTruthy();
  });

  it("atividade real DEPOIS da janela (ação humana no negócio) continua valendo mesmo com envio falho", async () => {
    const { h, id, m } = await pedido(12);
    await fail(m);
    expect(await awaiting(id)).toBe(true); // só o pedido de envio (dentro da janela): não é atendimento
    await q("update public.opportunities set last_commercial_activity_at = now() where contact_id=$1", [h.contactId]); // 12 min depois da criação
    expect(await awaiting(id)).toBe(false);
  });

  it("concorrência: confirmação chegando antes da escalada impede a troca; falha chegando antes permite", async () => {
    const a = await pedido(2);
    await confirm(a.m);
    expect(await escalate(a.id)).toBeNull();
    ({ db, q } = await setupHandoffDb());
    const b = await pedido(2);
    await fail(b.m);
    expect(await escalate(b.id)).toBeTruthy();
  });

  it("rodízio: envio em voo adia a redistribuição por no máximo 10 min; falha ou presa volta a redistribuir", async () => {
    for (const [age, falha, redistribui] of [[3, false, false], [3, true, true], [11, false, true]] as const) {
      ({ db, q } = await setupHandoffDb());
      const r = await rodizio();
      await backdate(r.id);
      await accept(r.id, r.marina);
      const m = await msg(r.w, r.h.conversationId, { id: null, at: -age });
      if (falha) await fail(m);
      const out = (await q("select public.redistribute_assignment($1,$2) as id", [r.id, inMinutes(60)]))[0].id;
      expect(Boolean(out)).toBe(redistribui);
    }
  });
});
