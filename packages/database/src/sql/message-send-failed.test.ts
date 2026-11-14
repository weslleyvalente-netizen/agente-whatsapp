import { beforeAll, describe, expect, it } from "vitest";
import { createRealSchemaDb } from "./real-schema-db.js";
import { markMessageSendFailed } from "../queries/messages.js";
import { hasOutboundMessageAfter } from "../queries/unanswered-leads.js";
import { countRecentSendFailures } from "../queries/messages.js";
import { listManagerUserIds } from "../queries/push.js";
import { createTaskWithDedup, findOpenTaskWithPendencyType, resolveAwaitingCustomerPendency, recoverSendFailures, closeSinglePendency } from "../queries/tasks.js";

// Esquema REAL (migrações aplicadas): mensagem nossa que falhou ao enviar NÃO conta como resposta entregue.
// Caso real: conversa do lead de "Pos venda" (13/11): 2 mensagens da MarIAna sem evolution_message_id e sem entrega.
let pg: any; let db: any; let org: string; let conv: string;
const one = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows[0];
const addMsg = async (role: string, at: string, over: { evo?: string | null; meta?: object } = {}) =>
  (await one("insert into messages(conversation_id, organization_id, role, content, created_at, evolution_message_id, metadata) values ($1,$2,$3,'x',$4,$5,$6) returning id",
    [conv, org, role, at, over.evo ?? null, over.meta ? JSON.stringify(over.meta) : null])).id as string;

beforeAll(async () => {
  const env = await createRealSchemaDb(); pg = env.pg; db = env.client;
  expect(env.failedMigrations).toEqual([]);
  org = (await one("insert into organizations(name, slug, settings) values ('MT','mt','{}') returning id")).id;
  const agent = (await one("insert into agents(organization_id, name, system_prompt) values ($1,'M','x') returning id", [org])).id;
  const inst = (await one("insert into evolution_instances(organization_id, instance_name, instance_id) values ($1,'Pos venda','a') returning id", [org])).id;
  const contact = (await one("insert into wa_contacts(organization_id, phone) values ($1,'185796074164331@lid') returning id", [org])).id;
  conv = (await one("insert into conversations(organization_id, agent_id, evolution_instance_id, contact_id) values ($1,$2,$3,$4) returning id", [org, agent, inst, contact])).id;
}, 180_000);

describe("mensagem que falhou ao enviar", () => {
  it("markMessageSendFailed grava send_failed_at e o motivo; é idempotente e nunca marca mensagem já enviada", async () => {
    const failed = await addMsg("agent", "2026-11-13T19:47:17Z");
    expect(await markMessageSendFailed(db, failed, "Evolution API send error 400: Connection Closed")).toBe(true);
    const row = await one("select metadata from messages where id=$1", [failed]);
    expect(row.metadata.send_failed_at).toBeTruthy(); expect(row.metadata.send_error).toContain("400");
    const first = row.metadata.send_failed_at;
    expect(await markMessageSendFailed(db, failed, "outro erro")).toBe(false);
    expect((await one("select metadata from messages where id=$1", [failed])).metadata.send_failed_at).toBe(first);
    const sent = await addMsg("agent", "2026-11-13T19:48:00Z", { evo: "EVO-1" });
    expect(await markMessageSendFailed(db, sent, "x")).toBe(false);
    expect((await one("select metadata from messages where id=$1", [sent])).metadata).toBeNull();
  });
  it("preserva os outros campos do metadata", async () => {
    const id = await addMsg("agent", "2026-11-13T19:49:00Z", { meta: { model: "claude", tool_calls: [] } });
    await markMessageSendFailed(db, id, "x");
    const m = (await one("select metadata from messages where id=$1", [id])).metadata;
    expect(m.model).toBe("claude"); expect(m.send_failed_at).toBeTruthy();
  });
  it("hasOutboundMessageAfter: falha NÃO conta como resposta; mensagem enviada conta", async () => {
    const c2 = (await one("insert into conversations(organization_id, agent_id, evolution_instance_id, contact_id) select organization_id, agent_id, evolution_instance_id, contact_id from conversations where id=$1 returning id", [conv])).id;
    const add = (role: string, at: string, evo: string | null) => pg.query("insert into messages(conversation_id, organization_id, role, content, created_at, evolution_message_id) values ($1,$2,$3,'x',$4,$5)", [c2, org, role, at, evo]);
    await add("contact", "2026-11-13T13:27:18Z", "C1");
    const out = (await one("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'agent','resposta','2026-11-13T19:47:17Z') returning id", [c2, org])).id;
    // antes de marcar: a regra antiga enxergava "respondido" (o bug)
    expect(await hasOutboundMessageAfter(db, c2, "2026-11-13T13:27:18Z")).toBe(true);
    await markMessageSendFailed(db, out, "Evolution API send error 400");
    expect(await hasOutboundMessageAfter(db, c2, "2026-11-13T13:27:18Z")).toBe(false); // agora o lead volta a ser "sem resposta"
    await add("human_agent", "2026-11-13T21:00:00Z", "H1");
    expect(await hasOutboundMessageAfter(db, c2, "2026-11-13T13:27:18Z")).toBe(true);
  });

  it("countRecentSendFailures: conta só falhas definitivas da janela (esquema real)", async () => {
    const fresh = await addMsg("agent", "2026-11-14T10:00:00Z"); await markMessageSendFailed(db, fresh, "Evolution API send error 400");
    const noFail = await addMsg("agent", "2026-11-14T10:01:00Z", { evo: "OK-1" }); void noFail;
    const old = await addMsg("agent", "2026-11-14T10:02:00Z", { meta: { send_failed_at: "2026-11-01T10:00:00.000Z" } }); void old;
    expect(await countRecentSendFailures(db, org, "2026-11-10T00:00:00.000Z")).toBeGreaterThanOrEqual(1);
    const before = await countRecentSendFailures(db, org, "2099-01-01T00:00:00.000Z");
    expect(before).toBe(0); // janela no futuro: nenhuma
    const inWindow = await countRecentSendFailures(db, org, new Date(Date.now() - 60_000).toISOString());
    expect(inWindow).toBeGreaterThanOrEqual(1); // a marca recém-gravada usa o horário atual
  });
  it("listManagerUserIds: só owner e admin da organização", async () => {
    const mk = async (role: string) => { const id = (await one("insert into auth.users(id, email) values (gen_random_uuid(), $1) returning id", [`${role}-${Math.random()}@x`])).id; await pg.query("insert into organization_members(organization_id, user_id, role) values ($1,$2,$3)", [org, id, role]); return id as string; };
    const owner = await mk("owner"); const admin = await mk("admin"); const agent = await mk("agent");
    const managers = await listManagerUserIds(db, org);
    expect(managers).toEqual(expect.arrayContaining([owner, admin])); expect(managers).not.toContain(agent);
  });

  it("tarefa 'message_send_failed' no esquema real: cria com dedupe por contato, é achada pela pendência e só encerra com reenvio POSTERIOR", async () => {
    const ct = (await one("insert into wa_contacts(organization_id, phone) values ($1,'5562911111111') returning id", [org])).id as string;
    const input = { organization_id: org, contact_id: ct, conversation_id: conv, opportunity_id: null, type: "message_send_failed" as const, description: "A mensagem NÃO foi entregue", reason: "Falha definitiva", priority: "high" as const,
      due_date: "2026-11-16", created_by_type: "ai" as const, created_by_id: null };
    const first = await createTaskWithDedup(db, input);
    const again = await createTaskWithDedup(db, { ...input, description: "outra falha" });
    expect(again.task.id).toBe(first.task.id); // dedupe: uma tarefa por contato
    const found = await findOpenTaskWithPendencyType(db, org, ct, "message_send_failed");
    expect(found?.id).toBe(first.task.id);
    const createdAt = (await one("select created_at from tasks where id=$1", [first.task.id])).created_at as string;
    // um envio ANTERIOR à tarefa não a encerra
    await resolveAwaitingCustomerPendency(db, org, first.task.id, "message_send_failed", "x", 0, new Date(Date.parse(createdAt) - 60_000).toISOString());
    expect((await one("select status from tasks where id=$1", [first.task.id])).status).toBe("pending");
    // um reenvio POSTERIOR a encerra
    await resolveAwaitingCustomerPendency(db, org, first.task.id, "message_send_failed", "Mensagem reenviada com sucesso", 0, new Date(Date.parse(createdAt) + 60_000).toISOString());
    expect((await one("select status from tasks where id=$1", [first.task.id])).status).toBe("completed");
  });
});

// ---- Encerramento da falha só com evidência (esquema real) ----
describe("tarefa 'Mensagem não enviada': encerramento por evidência", () => {
  let ct: string; let convA: string; let convB: string;
  const mkConv = async (contact: string) => (await one("insert into conversations(organization_id, agent_id, evolution_instance_id, contact_id) select organization_id, agent_id, evolution_instance_id, $2 from conversations where id=$1 returning id", [conv, contact])).id as string;
  const msg = async (c: string, role: string, at: string, content: string, over: { evo?: string | null; meta?: object; media?: string | null } = {}) =>
    (await one("insert into messages(conversation_id, organization_id, role, content, created_at, evolution_message_id, metadata, media_type) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id", [c, org, role, content, at, over.evo ?? null, over.meta ? JSON.stringify(over.meta) : null, over.media ?? null])).id as string;
  const fail = async (c: string, mid: string, at = "2026-11-14T12:00:00.000Z") => createTaskWithDedup(db, {
    organization_id: org, contact_id: ct, conversation_id: c, opportunity_id: null, type: "message_send_failed", description: "A mensagem NÃO foi entregue", reason: "Falha", priority: "high",
    due_date: "2026-11-16", created_by_type: "ai", created_by_id: null, assignee_type: null, assignee_id: null, failed_message: { message_id: mid, conversation_id: c, failed_at: at } });
  const accepted = async (id: string) => { const r = await one("select id, conversation_id, content, media_type, metadata, created_at from messages where id=$1", [id]); return { ...r, metadata: r.metadata ?? null }; };
  const taskRow = async () => one("select id, status, assignee_type, assignee_id, consolidated_pendencies from tasks where contact_id=$1 and type='message_send_failed' order by created_at desc limit 1", [ct]);
  const refs = (row: any) => (row.consolidated_pendencies[0].failed_messages as any[]).map((f) => f.message_id).sort();
  beforeAll(async () => {
    ct = (await one("insert into wa_contacts(organization_id, phone) values ($1,'5562933333333') returning id", [org])).id;
    convA = await mkConv(ct); convB = await mkConv(ct);
  });

  it("duas falhas consecutivas na MESMA conversa viram uma tarefa sem perder a referência de nenhuma mensagem; sem responsável fica sem responsável", async () => {
    const m1 = await msg(convA, "human_agent", "2026-11-14T12:00:00Z", "Segue a proposta de 90 mil");
    const m2 = await msg(convA, "human_agent", "2026-11-14T12:05:00Z", "Pode confirmar?");
    const t1 = await fail(convA, m1); const t2 = await fail(convA, m2, "2026-11-14T12:05:00.000Z");
    expect(t2.task.id).toBe(t1.task.id);
    const row = await taskRow();
    expect(refs(row)).toEqual([m1, m2].sort());
    expect(row.assignee_type).toBeNull(); expect(row.assignee_id).toBeNull(); // nunca "da IA"
    expect(row.consolidated_pendencies[0].description).toContain("2 mensagens");
    // repetir a MESMA falha não duplica a referência
    await fail(convA, m2, "2026-11-14T12:06:00.000Z"); expect(refs(await taskRow())).toEqual([m1, m2].sort());
  });

  it("mensagem GENÉRICA posterior aceita pela Evolution NÃO encerra a falha", async () => {
    const hello = await msg(convA, "human_agent", "2026-11-14T13:00:00Z", "Bom dia!", { evo: "OK-HELLO" });
    expect(await recoverSendFailures(db, org, ct, await accepted(hello))).toBe(0);
    const row = await taskRow(); expect(row.status).toBe("pending"); expect(row.consolidated_pendencies[0].failed_messages).toHaveLength(2);
  });

  it("reenvio do conteúdo de UMA das mensagens recupera só aquela; a outra continua pendente", async () => {
    const [first] = (await taskRow()).consolidated_pendencies[0].failed_messages.map((f: any) => f.message_id) as string[];
    const content = (await one("select content from messages where id=$1", [first])).content as string;
    const resend = await msg(convA, "human_agent", "2026-11-14T13:10:00Z", `  ${content.toUpperCase()} `, { evo: "OK-R1" });
    expect(await recoverSendFailures(db, org, ct, await accepted(resend))).toBe(1);
    const row = await taskRow(); expect(row.status).toBe("pending"); expect(refs(row)).not.toContain(first); expect(row.consolidated_pendencies[0].failed_messages).toHaveLength(1);
  });

  it("outra CONVERSA do mesmo contato não provoca encerramento cruzado (nem com o mesmo texto)", async () => {
    const [left] = (await taskRow()).consolidated_pendencies[0].failed_messages.map((f: any) => f.message_id) as string[];
    const content = (await one("select content from messages where id=$1", [left])).content as string;
    const other = await msg(convB, "human_agent", "2026-11-14T13:20:00Z", content, { evo: "OK-B" });
    expect(await recoverSendFailures(db, org, ct, await accepted(other))).toBe(0);
    expect((await taskRow()).consolidated_pendencies[0].failed_messages).toHaveLength(1);
  });

  it("uma falha na conversa B soma à tarefa; recuperar a A não encerra a B", async () => {
    const mb = await msg(convB, "agent", "2026-11-14T13:30:00Z", "Olá, sou a MarIAna");
    await fail(convB, mb, "2026-11-14T13:30:00.000Z");
    const row = await taskRow(); expect(row.consolidated_pendencies[0].failed_messages).toHaveLength(2);
    const [fa] = row.consolidated_pendencies[0].failed_messages.filter((f: any) => f.conversation_id === convA).map((f: any) => f.message_id) as string[];
    const content = (await one("select content from messages where id=$1", [fa])).content as string;
    const resendA = await msg(convA, "human_agent", "2026-11-14T13:40:00Z", content, { evo: "OK-RA" });
    expect(await recoverSendFailures(db, org, ct, await accepted(resendA))).toBe(1);
    const after = await taskRow(); expect(after.status).toBe("pending"); expect(after.consolidated_pendencies[0].failed_messages.map((f: any) => f.conversation_id)).toEqual([convB]);
  });

  it("mensagem ANTERIOR à falha ou sem texto não serve de evidência; resend_of explícito e reprocessamento da mesma mensagem servem", async () => {
    const [fb] = (await taskRow()).consolidated_pendencies[0].failed_messages.map((f: any) => f.message_id) as string[];
    const before = await msg(convB, "agent", "2026-11-14T13:00:00Z", "Olá, sou a MarIAna", { evo: "OK-EARLIER" }); // mesmo texto, mas ANTES da falha
    expect(await recoverSendFailures(db, org, ct, await accepted(before))).toBe(0);
    const explicit = await msg(convB, "human_agent", "2026-11-14T14:00:00Z", "texto diferente, reescrito", { evo: "OK-X", meta: { resend_of: fb } });
    expect(await recoverSendFailures(db, org, ct, await accepted(explicit))).toBe(1);
    expect((await taskRow()).status).toBe("completed"); // era a última referência
  });

  it("a MESMA mensagem reprocessada com sucesso recupera a própria falha", async () => {
    const m = await msg(convA, "agent", "2026-11-14T15:00:00Z", "mensagem que falhou e foi reprocessada");
    await fail(convA, m, "2026-11-14T15:00:00.000Z");
    await pg.query("update messages set evolution_message_id='OK-SAME' where id=$1", [m]);
    expect(await recoverSendFailures(db, org, ct, await accepted(m))).toBe(1);
    expect((await taskRow()).status).toBe("completed");
  });

  it("mídia sem legenda nunca é recuperada por 'conteúdo igual' (só por id/resend_of)", async () => {
    const m = await msg(convA, "human_agent", "2026-11-14T16:00:00Z", "", { media: "image" });
    await fail(convA, m, "2026-11-14T16:00:00.000Z");
    const again = await msg(convA, "human_agent", "2026-11-14T16:05:00Z", "", { media: "image", evo: "OK-IMG" });
    expect(await recoverSendFailures(db, org, ct, await accepted(again))).toBe(0);
    expect((await taskRow()).status).toBe("pending");
  });

  it("confirmação MANUAL do vendedor encerra só a pendência 'Mensagem não enviada' (outras continuam)", async () => {
    const row = await taskRow(); expect(row.status).toBe("pending");
    // outra obrigação na mesma tarefa consolidada: precisa de um negócio (consolidação por negócio)
    await pg.query("update tasks set consolidated_pendencies = consolidated_pendencies || $2::jsonb where id=$1", [row.id, JSON.stringify([{ type: "request_documents", description: "cobrar documentos", reason: null, priority: "normal", due_date: "2026-11-16", due_time: null, added_at: "2026-11-14T16:10:00.000Z", added_by_type: "ai", added_by_id: null }])]);
    const closed = await closeSinglePendency(db, row.id, { actor: { type: "human", id: null }, note: "Reenvio confirmado manualmente pelo vendedor.", pendencyType: "message_send_failed" });
    expect(closed?.status).not.toBe("completed");
    expect(closed?.consolidated_pendencies.map((p: any) => p.type)).toEqual(["request_documents"]);
  });
});
