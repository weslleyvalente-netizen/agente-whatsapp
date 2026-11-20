// Varreduras de SLA limitadas (20261120120000): a espera da primeira resposta é encerrada só por resposta CONFIRMADA do vendedor
// (ou de autoria desconhecida) e a cobrança de atribuições assumidas olha só os últimos 5 dias. Nenhuma decisão de negócio muda.
import { beforeEach, describe, expect, it } from "vitest";
import { inMinutes } from "./harness.js";
import { ALL_ON, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => { ({ db, q } = await setupHandoffDb()); });

const ON = { ...ALL_ON, sla_alert_escalation_enabled: true };
const THREE: Array<[string, number, string?]> = [["Marina", 1], ["Márcio", 2], ["Paulo", 3]];
const row = async (id: string) => (await q("select * from public.lead_assignments where id=$1", [id]))[0];
const flag = async () => (await q("select public.flag_sla_alerts() as n"))[0].n as number;
// sla_due_at é protegido por gatilho (imutável): o teste envelhece o prazo com os gatilhos desligados.
const ageDue = async (id: string) => { await q("set session_replication_role = replica"); await q("update public.lead_assignments set sla_due_at = now() - interval '6 days' where id=$1", [id]); await q("set session_replication_role = origin"); };
const accept = (id: string, userId: string) => q("select public.accept_assignment($1,$2,false)", [id, userId]);

/** Carteira do Márcio, assumida pelo botão, com o prazo vencido. */
async function assumida() {
  const w = await seedWorld(db, ON, THREE);
  const h = await seedLead(db, w.org, { assignedTo: w.reps["Márcio"].userId, handedAt: inMinutes(-130) });
  const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(-70)]))[0].id as string;
  await accept(id, w.reps["Márcio"].userId);
  expect(await row(id)).toMatchObject({ status: "accepted", awaiting_first_response: true });
  return { w, h, id, marcio: w.reps["Márcio"].userId };
}
const msg = (w: { org: string }, conv: string, o: { waId?: string | null; failed?: boolean; author?: string } = {}) =>
  q("insert into public.messages(organization_id,conversation_id,role,content,evolution_message_id,metadata,created_at) values ($1,$2,'human_agent','Oi',$3,$4::jsonb,now())",
    [w.org, conv, o.waId === undefined ? "wa-" + Math.random().toString(36).slice(2) : o.waId,
     JSON.stringify({ ...(o.failed ? { send_failed_at: new Date().toISOString() } : {}), ...(o.author ? { sent_by_user_id: o.author } : {}) })]);

describe("flag_sla_alerts encerra a espera respondida e não reavalia para sempre", () => {
  it("resposta confirmada do vendedor: a espera é encerrada e a cobrança não marca atraso", async () => {
    const { w, h, id, marcio } = await assumida();
    await msg(w, h.conversationId, { author: marcio });
    await flag();
    expect(await row(id)).toMatchObject({ awaiting_first_response: false, sla_breached: false, status: "accepted" });
  });

  it("resposta confirmada do celular da loja (autor desconhecido) também encerra", async () => {
    const { w, h, id } = await assumida();
    await msg(w, h.conversationId);
    await flag();
    expect((await row(id)).awaiting_first_response).toBe(false);
  });

  it("mensagem em voo (sem id do WhatsApp) NÃO encerra: se falhar depois, a espera continua", async () => {
    const { w, h, id, marcio } = await assumida();
    await msg(w, h.conversationId, { waId: null, author: marcio });
    await flag();
    expect((await row(id)).awaiting_first_response).toBe(true);
  });

  it("mensagem com falha NÃO encerra e o atraso é cobrado", async () => {
    const { w, h, id, marcio } = await assumida();
    await msg(w, h.conversationId, { failed: true, author: marcio });
    await flag();
    expect(await row(id)).toMatchObject({ awaiting_first_response: true, sla_breached: true });
  });

  it("mensagem de OUTRO autor (gestor pelo painel) NÃO encerra a espera do vendedor", async () => {
    const { w, h, id } = await assumida();
    await msg(w, h.conversationId, { author: w.reps["Marina"].userId });
    await flag();
    expect(await row(id)).toMatchObject({ awaiting_first_response: true, sla_breached: true });
  });

  it("assumida sem resposta e prazo vencido: cobra (igual a antes)", async () => {
    const { id } = await assumida();
    expect(await flag()).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toMatchObject({ awaiting_first_response: true, sla_breached: true });
  });

  it("prazo vencido há mais de 5 dias: sai do acompanhamento e não é cobrada", async () => {
    const { id } = await assumida();
    await ageDue(id);
    await flag();
    expect(await row(id)).toMatchObject({ awaiting_first_response: false, sla_breached: false });
  });

  it("pendente continua sendo cobrada como antes, mesmo antiga", async () => {
    const w = await seedWorld(db, ON, THREE);
    const h = await seedLead(db, w.org, { assignedTo: w.reps["Márcio"].userId, handedAt: inMinutes(-130) });
    const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(-70)]))[0].id as string;
    await ageDue(id);
    await flag();
    expect(await row(id)).toMatchObject({ status: "pending", sla_breached: true });
  });

  it("índice por conversa existe", async () => {
    expect((await q("select 1 from pg_indexes where indexname='lead_assignments_conversation'")).length).toBe(1);
  });
});
