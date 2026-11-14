import { beforeAll, describe, expect, it } from "vitest";
import { createRealSchemaDb } from "./real-schema-db.js";
import { markMessageSendFailed } from "../queries/messages.js";
import { hasOutboundMessageAfter } from "../queries/unanswered-leads.js";

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
});
