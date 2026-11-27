// Fase C (plano de estabilização 26/11): o lead nunca fica sem responsável explícito; a exceção fecha quando o vendedor responde;
// encaminhamento repetido durante atendimento humano ativo não reinicia o rodízio. Chaves novas desligadas por padrão.
import { beforeEach, describe, expect, it } from "vitest";
import { inMinutes } from "./harness.js";
import { ALL_ON, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => { ({ db, q } = await setupHandoffDb()); });

const TWO: Array<[string, number, string?]> = [["Marina", 1], ["Márcio", 2]];
const row = async (id: string) => (await q("select * from public.lead_assignments where id=$1", [id]))[0];
const distribute = async (org: string, h: { conversationId: string; handoffId: string }, sla = inMinutes(-5)) =>
  (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, sla]))[0].id as string;
const redistribute = async (id: string) => (await q("select public.redistribute_assignment($1,$2) as id", [id, inMinutes(-5)]))[0].id as string | null;
const humanMsg = (org: string, conv: string, at = new Date().toISOString()) =>
  q("insert into public.messages(organization_id,conversation_id,role,content,evolution_message_id,metadata,created_at) values ($1,$2,'human_agent','Oi','wa-'||gen_random_uuid(),'{}'::jsonb,$3)", [org, conv, at]);
const record = (org: string, conv: string, user: string | null, via = "panel", at = new Date().toISOString()) =>
  q("select public.record_human_message($1,$2,$3,$4,$5)", [org, conv, at, user, via]);

/** Lead novo: rodízio Marina → (vence) Márcio → (vence) exceção. Devolve a exceção. */
async function esgotado(settings: Record<string, unknown> = ALL_ON) {
  const w = await seedWorld(db, settings, TWO);
  const h = await seedLead(db, w.org, { handedAt: inMinutes(-200) });
  const first = await distribute(w.org, h);
  expect(await row(first)).toMatchObject({ rep_id: w.reps["Marina"].repId, reason: "round_robin" });
  const second = (await redistribute(first))!;
  expect(await row(second)).toMatchObject({ rep_id: w.reps["Márcio"].repId, reason: "sla_redistribution" });
  const exc = (await redistribute(second))!;
  return { w, h, exc };
}

describe("responsável explícito quando o rodízio se esgota", () => {
  it("a exceção registra o último vendedor como responsável; conversa e card continuam com ele", async () => {
    const { w, h, exc } = await esgotado();
    const e = await row(exc);
    expect(e).toMatchObject({ status: "exception", exception_reason: "all_reps_sla_breached", rep_id: null, responsible_rep_id: w.reps["Márcio"].repId });
    expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).toBe(w.reps["Márcio"].userId);
    expect((await q("select owner_id from public.opportunities where contact_id=$1 and status='open'", [h.contactId]))[0].owner_id).toBe(w.reps["Márcio"].userId);
  });

  it("exceção direta (nenhum vendedor disponível): responsável = vendedor que já está com a conversa, se houver", async () => {
    const w = await seedWorld(db, ALL_ON, [["Marina", 1, "out"], ["Márcio", 2, "out"]]);
    const h = await seedLead(db, w.org, { assignedTo: w.reps["Márcio"].userId, handedAt: inMinutes(-10) });
    await q("update public.sales_reps set availability='available' where id=$1", [w.reps["Márcio"].repId]);
    await q("delete from public.organization_members where user_id=$1", [w.reps["Márcio"].userId]); // dono inválido → exceção
    const id = await distribute(w.org, h, inMinutes(30));
    expect(await row(id)).toMatchObject({ status: "exception", responsible_rep_id: w.reps["Márcio"].repId });
  });
});

describe("exceção fecha quando o vendedor responde (exception_auto_resolve_enabled)", () => {
  it("chave ligada: resposta registrada fecha a exceção como 'answered_by_seller', com autor e horário", async () => {
    const { w, h, exc } = await esgotado({ ...ALL_ON, exception_auto_resolve_enabled: true });
    await humanMsg(w.org, h.conversationId);
    await record(w.org, h.conversationId, w.reps["Márcio"].userId);
    expect(await row(exc)).toMatchObject({ resolution: "answered_by_seller", resolved_by: w.reps["Márcio"].userId });
    expect((await row(exc)).resolved_at).not.toBeNull();
  });

  it("chave desligada (padrão): exceção continua aberta (comportamento de hoje)", async () => {
    const { w, h, exc } = await esgotado();
    await humanMsg(w.org, h.conversationId);
    await record(w.org, h.conversationId, w.reps["Márcio"].userId);
    expect(await row(exc)).toMatchObject({ resolved_at: null, resolution: null });
  });

  it("resposta com horário ANTERIOR à exceção não fecha", async () => {
    const { w, h, exc } = await esgotado({ ...ALL_ON, exception_auto_resolve_enabled: true });
    await record(w.org, h.conversationId, w.reps["Márcio"].userId, "panel", inMinutes(-300));
    expect((await row(exc)).resolved_at).toBeNull();
  });
});

describe("encaminhamento repetido durante atendimento ativo (repeat_handoff_keeps_assignment_enabled)", () => {
  async function atendimentoAtivo(settings: Record<string, unknown>) {
    const w = await seedWorld(db, settings, TWO);
    const h = await seedLead(db, w.org, { handedAt: inMinutes(-60) });
    const id = await distribute(w.org, h, inMinutes(30));
    const rep = (await row(id)).rep_id as string;
    const user = rep === w.reps["Marina"].repId ? w.reps["Marina"].userId : w.reps["Márcio"].userId;
    await humanMsg(w.org, h.conversationId);
    await record(w.org, h.conversationId, user);
    expect(await row(id)).toMatchObject({ status: "accepted" });
    const h2 = (await q("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,now()) returning id", [w.org, h.conversationId]))[0].id as string;
    return { w, h, id, h2 };
  }

  it("chave ligada: não reinicia o ciclo; mantém a atribuição e marca que o cliente voltou a escrever", async () => {
    const { w, h, id, h2 } = await atendimentoAtivo({ ...ALL_ON, repeat_handoff_keeps_assignment_enabled: true });
    const before = (await q("select count(*)::int n from public.lead_assignments where conversation_id=$1", [h.conversationId]))[0].n;
    const back = await distribute(w.org, { conversationId: h.conversationId, handoffId: h2 }, inMinutes(30));
    expect(back).toBe(id);
    expect((await q("select count(*)::int n from public.lead_assignments where conversation_id=$1", [h.conversationId]))[0].n).toBe(before);
    expect(await row(id)).toMatchObject({ status: "accepted" });
    expect((await row(id)).last_customer_followup_at).not.toBeNull();
  });

  it("chave desligada (padrão): reinicia como hoje (atribuição anterior vira 'redistributed')", async () => {
    const { w, h, id, h2 } = await atendimentoAtivo(ALL_ON);
    const back = await distribute(w.org, { conversationId: h.conversationId, handoffId: h2 }, inMinutes(30));
    expect(back).not.toBe(id);
    expect(await row(id)).toMatchObject({ status: "redistributed", redistribution_reason: "new_handoff" });
  });

  it("chave ligada, mas sem mensagem do vendedor nas últimas 24 h: reinicia (o atendimento não está ativo)", async () => {
    const w = await seedWorld(db, { ...ALL_ON, repeat_handoff_keeps_assignment_enabled: true }, TWO);
    const h = await seedLead(db, w.org, { handedAt: inMinutes(-3000) });
    const id = await distribute(w.org, h, inMinutes(30));
    const rep = (await row(id)).rep_id as string;
    const user = rep === w.reps["Marina"].repId ? w.reps["Marina"].userId : w.reps["Márcio"].userId;
    // atendimento antigo: atribuição e resposta de ~33 h atrás (recua assigned_at como os demais testes do rodízio)
    await q("alter table public.lead_assignments disable trigger lead_assignments_guard_update");
    await q("update public.lead_assignments set assigned_at = assigned_at - interval '3000 minutes' where id=$1", [id]);
    await q("alter table public.lead_assignments enable trigger lead_assignments_guard_update");
    await humanMsg(w.org, h.conversationId, inMinutes(-2000));
    await record(w.org, h.conversationId, user, "panel", inMinutes(-2000));
    expect(await row(id)).toMatchObject({ status: "accepted" });
    const h2 = (await q("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,now()) returning id", [w.org, h.conversationId]))[0].id as string;
    expect(await distribute(w.org, { conversationId: h.conversationId, handoffId: h2 }, inMinutes(30))).not.toBe(id);
  });
});

describe("encaminhamento repetido ANTES da primeira resposta humana (cliente ainda aguardando)", () => {
  const KEEP = { ...ALL_ON, repeat_handoff_keeps_assignment_enabled: true };
  const handoff = async (org: string, conv: string, at = "now()") =>
    (await q(`insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,${at}) returning id`, [org, conv]))[0].id as string;
  const pointer = async (org: string) => (await q("select last_rotation_order from public.lead_distribution_state where organization_id=$1", [org]))[0]?.last_rotation_order;
  const count = async (conv: string) => (await q("select count(*)::int n from public.lead_assignments where conversation_id=$1", [conv]))[0].n as number;

  for (const [nome, settings] of [["chave ligada", KEEP], ["chave desligada", ALL_ON]] as const) {
    it(`${nome}: pendente dentro do prazo — novo encaminhamento devolve a MESMA atribuição; prazo, ponteiro do rodízio e linhas não mudam`, async () => {
      const w = await seedWorld(db, settings, TWO);
      const h = await seedLead(db, w.org, { handedAt: inMinutes(-5) });
      const id = await distribute(w.org, h, inMinutes(30));
      const before = { ...(await row(id)) }; const ptr = await pointer(w.org); const n = await count(h.conversationId);
      const h2 = await handoff(w.org, h.conversationId);
      expect(await distribute(w.org, { conversationId: h.conversationId, handoffId: h2 }, inMinutes(90))).toBe(id);
      const after = await row(id);
      expect(after).toMatchObject({ status: "pending", rep_id: before.rep_id, sla_due_at: before.sla_due_at, assigned_at: before.assigned_at });
      expect(await pointer(w.org)).toBe(ptr);
      expect(await count(h.conversationId)).toBe(n);
      if (nome === "chave ligada") expect(after.last_customer_followup_at).not.toBeNull();
    });
  }

  it("mensagens simultâneas: vários encaminhamentos no mesmo instante e o mesmo encaminhamento reprocessado geram UMA atribuição", async () => {
    const w = await seedWorld(db, KEEP, TWO);
    const h = await seedLead(db, w.org, { handedAt: inMinutes(-1) });
    const at = `'${new Date().toISOString()}'::timestamptz`;
    const hs = [h.handoffId, await handoff(w.org, h.conversationId, at), await handoff(w.org, h.conversationId, at), await handoff(w.org, h.conversationId, at)];
    const ids = new Set<string>();
    for (const hid of [...hs, hs[0], hs[2]]) ids.add(await distribute(w.org, { conversationId: h.conversationId, handoffId: hid }, inMinutes(30)));
    expect(ids.size).toBe(1);
    expect(await count(h.conversationId)).toBe(1);
  });

  it("rodízio esgotado (exceção aberta, ninguém respondeu): nova mensagem NÃO recomeça o rodízio; a exceção continua com o responsável e marca o retorno do cliente", async () => {
    const { w, h, exc } = await esgotado(KEEP);
    const n = await count(h.conversationId);
    const h2 = await handoff(w.org, h.conversationId);
    expect(await distribute(w.org, { conversationId: h.conversationId, handoffId: h2 }, inMinutes(30))).toBe(exc);
    expect(await count(h.conversationId)).toBe(n);
    expect(await row(exc)).toMatchObject({ status: "exception", resolved_at: null, responsible_rep_id: w.reps["Márcio"].repId });
    expect((await row(exc)).last_customer_followup_at).not.toBeNull();
  });

  it("rodízio esgotado com a chave desligada: comportamento de hoje (exceção substituída e nova cadeia)", async () => {
    const { w, h, exc } = await esgotado(ALL_ON);
    const h2 = await handoff(w.org, h.conversationId);
    expect(await distribute(w.org, { conversationId: h.conversationId, handoffId: h2 }, inMinutes(30))).not.toBe(exc);
    expect(await row(exc)).toMatchObject({ resolution: "superseded_by_new_handoff" });
  });

  describe("regras preservadas com a chave ligada", () => {
    it("vencimento do prazo: a redistribuição continua acontecendo", async () => {
      const w = await seedWorld(db, KEEP, TWO);
      const h = await seedLead(db, w.org, { handedAt: inMinutes(-200) });
      const id = await distribute(w.org, h);
      const next = await redistribute(id);
      expect(next).toBeTruthy();
      expect(await row(id)).toMatchObject({ status: "expired" });
      expect(await row(next!)).toMatchObject({ status: "pending", reason: "sla_redistribution" });
    });
    it("indisponibilidade: vendedor que saiu da distribuição não recebe a redistribuição", async () => {
      const w = await seedWorld(db, KEEP, [["Marina", 1], ["Márcio", 2], ["Paulo", 3]]);
      const h = await seedLead(db, w.org, { handedAt: inMinutes(-200) });
      const id = await distribute(w.org, h);
      expect((await row(id)).rep_id).toBe(w.reps["Marina"].repId);
      await q("update public.sales_reps set availability='out' where id=$1", [w.reps["Márcio"].repId]);
      const next = await redistribute(id);
      expect((await row(next!)).rep_id).toBe(w.reps["Paulo"].repId);
    });
    it("transferência manual pelo gestor continua funcionando com o lead pendente", async () => {
      const w = await seedWorld(db, KEEP, TWO);
      const h = await seedLead(db, w.org, { handedAt: inMinutes(-5) });
      const id = await distribute(w.org, h, inMinutes(30));
      const other = (await row(id)).rep_id === w.reps["Marina"].repId ? w.reps["Márcio"] : w.reps["Marina"];
      const nid = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [w.org, h.conversationId, other.repId, w.def, inMinutes(30)]))[0].id as string;
      expect(await row(nid)).toMatchObject({ status: "pending", reason: "manual", rep_id: other.repId });
      expect(await row(id)).toMatchObject({ status: "redistributed", redistribution_reason: "manual" });
    });
  });
});

