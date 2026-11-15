import { beforeAll, describe, expect, it } from "vitest";
import { createRealSchemaDb } from "./real-schema-db.js";
import { reportSendFailure, reconcileUnreportedSendFailures, claimSendFailureReport, realSendFailureDeps } from "../queries/send-failure-report.js";
import { convergeSendFailureTasks, recoverSendFailures } from "../queries/tasks.js";
import { setMessageEvolutionId } from "../queries/messages.js";

// Esquema REAL: toda falha definitiva de envio (worker, API do inbox) passa pelo mesmo registro e deixa UMA pendência de recuperação
// no CRM com a referência de cada mensagem, sem duplicar aviso/tarefa, e só encerra com evidência de recuperação.
const NOW = new Date("2026-11-16T15:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
let pg: any; let db: any; let agent: string; let inst: string; let n = 0;
const one = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows[0];
const all = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows;

async function world(settings: object = { send_failure_tasks_enabled: true }) {
  const k = ++n;
  const org = (await one("insert into organizations(name, slug, settings) values ($1,$2,$3) returning id", [`Org${k}`, `org-${k}`, JSON.stringify(settings)])).id as string;
  const ag = (await one("insert into agents(organization_id, name, system_prompt) values ($1,'M','x') returning id", [org])).id as string;
  const ev = (await one("insert into evolution_instances(organization_id, instance_name, instance_id) values ($1,'Pos venda',$2) returning id", [org, `i${k}`])).id as string;
  const contact = (await one("insert into wa_contacts(organization_id, phone, name) values ($1,$2,'Romario') returning id", [org, `55629${String(k).padStart(8, "0")}`])).id as string;
  const conv = async () => (await one("insert into conversations(organization_id, agent_id, evolution_instance_id, contact_id) values ($1,$2,$3,$4) returning id", [org, ag, ev, contact])).id as string;
  const msg = async (c: string, content: string, over: { role?: string; at?: string; evo?: string | null; meta?: object; media?: string | null } = {}) =>
    (await one("insert into messages(conversation_id, organization_id, role, content, created_at, evolution_message_id, metadata, media_type) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
      [c, org, over.role ?? "human_agent", content, over.at ?? ago(10), over.evo ?? null, over.meta ? JSON.stringify(over.meta) : null, over.media ?? null])).id as string;
  const tasks = () => all("select id, status, assignee_type, consolidated_pendencies from tasks where contact_id=$1 and type='message_send_failed' order by created_at", [contact]);
  const open = async () => (await tasks()).filter((t: any) => ["pending", "in_progress", "rescheduled"].includes(t.status));
  const refs = (t: any) => (t.consolidated_pendencies.find((p: any) => p.type === "message_send_failed")?.failed_messages ?? []).map((f: any) => f.message_id).sort() as string[];
  const accepted = async (id: string) => { const r = await one("select id, conversation_id, content, media_type, metadata, created_at from messages where id=$1", [id]); return { ...r, metadata: r.metadata ?? null }; };
  return { org, contact, conv, msg, tasks, open, refs, accepted };
}

async function rawFailedTask(w: { org: string; contact: string }, c: string, m: string, at: string, extra: unknown[] = []) {
  await pg.query(
    "insert into tasks(organization_id, contact_id, conversation_id, type, title, description, priority, status, due_date, created_by_type, consolidated_pendencies, created_at) values ($1,$2,$3,'message_send_failed','Mensagem não enviada','d','high','pending','2026-11-16','ai',$4,$5)",
    [w.org, w.contact, c, JSON.stringify([{ type: "message_send_failed", description: "d", reason: null, priority: "high", due_date: "2026-11-16", due_time: null, added_at: at, added_by_type: "ai", added_by_id: null, failed_messages: [{ message_id: m, conversation_id: c, failed_at: at }] }, ...extra]), at]);
}

beforeAll(async () => { const env = await createRealSchemaDb(); pg = env.pg; db = env.client; expect(env.failedMigrations).toEqual([]); }, 180_000);

describe("mensagem do inbox (API) que falha: marca + uma pendência com a referência", () => {
  it("texto: marca send_failed_at, cria UMA tarefa sem responsável com a mensagem e a conversa; repetir o relato não duplica", async () => {
    const w = await world(); const c = await w.conv();
    const m = await w.msg(c, "Segue a proposta de 90 mil, consegue confirmar hoje?");
    const r1 = await reportSendFailure(db, { messageId: m, reason: "Falha ao enfileirar" }, NOW);
    expect(r1.claim).toBe("claimed"); expect(r1.result?.tasks).toBe(1);
    const row = await one("select metadata from messages where id=$1", [m]);
    expect(row.metadata.send_failed_at).toBeTruthy(); expect(row.metadata.send_failure_reported_at).toBeTruthy();
    const tasks = await w.open(); expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee_type).toBeNull(); expect(w.refs(tasks[0])).toEqual([m]);
    expect(tasks[0].consolidated_pendencies[0].failed_messages[0].conversation_id).toBe(c);
    for (let i = 0; i < 3; i++) expect((await reportSendFailure(db, { messageId: m, reason: "de novo" }, NOW)).claim).toBe("already_reported");
    expect(await w.open()).toHaveLength(1); expect(w.refs((await w.open())[0])).toEqual([m]);
  });
  it("áudio/anexo do vendedor JÁ marcados (send_failed_at) mas nunca reportados também geram a tarefa (lacuna que silenciava o alerta no worker)", async () => {
    const w = await world(); const c = await w.conv();
    const audio = await w.msg(c, "[audio]", { media: "audio", meta: { source: "seller_audio", send_failed_at: ago(9) } });
    const file = await w.msg(c, "[imagem]", { media: "image", meta: { source: "seller_attachment", send_failed_at: ago(8) } });
    expect((await reportSendFailure(db, { messageId: audio, reason: "x" }, NOW)).claim).toBe("claimed");
    expect((await reportSendFailure(db, { messageId: file, reason: "x" }, NOW)).claim).toBe("claimed");
    const t = await w.open(); expect(t).toHaveLength(1); expect(w.refs(t[0])).toEqual([audio, file].sort());
    expect((await one("select metadata from messages where id=$1", [audio])).metadata.source).toBe("seller_audio"); // metadata preservado
  });
  it("mensagem que a Evolution já aceitou nunca é reivindicada; mensagem do cliente ou inexistente também não", async () => {
    const w = await world(); const c = await w.conv();
    const sent = await w.msg(c, "já saiu", { evo: "EVO-1" });
    const inbound = await w.msg(c, "oi", { role: "contact" });
    expect((await reportSendFailure(db, { messageId: sent, reason: "x" }, NOW)).claim).toBe("delivered");
    expect((await reportSendFailure(db, { messageId: inbound, reason: "x" }, NOW)).claim).toBe("missing");
    expect((await reportSendFailure(db, { messageId: "00000000-0000-0000-0000-000000000000", reason: "x" }, NOW)).claim).toBe("missing");
    expect(await w.open()).toHaveLength(0);
  });
});

describe("múltiplas tentativas e falhas simultâneas", () => {
  it("a MESMA mensagem relatada em paralelo (retries/reprocessos) gera um aviso e uma tarefa", async () => {
    const w = await world(); const c = await w.conv(); const m = await w.msg(c, "texto longo o bastante para ser comercial");
    const out = await Promise.all(Array.from({ length: 5 }, () => reportSendFailure(db, { messageId: m, reason: "x" }, NOW)));
    expect(out.filter((o) => o.claim === "claimed")).toHaveLength(1);
    expect(await w.open()).toHaveLength(1);
  });
  it("seis mensagens falhando AO MESMO TEMPO (2 conversas, mesmo contato) convergem numa só tarefa com as seis referências", async () => {
    const w = await world(); const a = await w.conv(); const b = await w.conv();
    const ids = await Promise.all([a, a, a, b, b, b].map((c, i) => w.msg(c, `mensagem comercial número ${i} para o cliente`, { at: ago(10 - i) })));
    await Promise.all(ids.map((id) => reportSendFailure(db, { messageId: id, reason: "x" }, NOW)));
    const open = await w.open();
    expect(open).toHaveLength(1);
    expect(w.refs(open[0])).toEqual([...ids].sort());
    const all2 = await w.tasks(); // as eventuais duplicadas ficaram canceladas, nunca abertas
    expect(all2.filter((t: any) => t.status !== "cancelled")).toHaveLength(1);
  });
  it("convergeSendFailureTasks: duas tarefas abertas viram uma (união das referências); a duplicada é cancelada; idempotente", async () => {
    const w = await world(); const c = await w.conv();
    const m1 = await w.msg(c, "primeira mensagem comercial longa"); const m2 = await w.msg(c, "segunda mensagem comercial longa");
    await rawFailedTask(w, c, m1, "2026-11-16T14:00:00Z"); await rawFailedTask(w, c, m2, "2026-11-16T14:01:00Z");
    const keptId = await convergeSendFailureTasks(db, w.org, w.contact);
    const open = await w.open(); expect(open).toHaveLength(1); expect(open[0].id).toBe(keptId); expect(w.refs(open[0])).toEqual([m1, m2].sort());
    expect((await w.tasks()).filter((t: any) => t.status === "cancelled")).toHaveLength(1);
    expect(await convergeSendFailureTasks(db, w.org, w.contact)).toBe(keptId);
  });
  it("convergeSendFailureTasks: duplicada que carrega OUTRA obrigação não é cancelada (nada se perde)", async () => {
    const w = await world(); const c = await w.conv();
    const m1 = await w.msg(c, "primeira mensagem comercial longa"); const m2 = await w.msg(c, "segunda mensagem comercial longa");
    const docs = { type: "request_documents", description: "cobrar documentos", reason: null, priority: "normal", due_date: "2026-11-16", due_time: null, added_at: "2026-11-16T14:01:00Z", added_by_type: "ai", added_by_id: null };
    await rawFailedTask(w, c, m1, "2026-11-16T14:00:00Z"); await rawFailedTask(w, c, m2, "2026-11-16T14:01:00Z", [docs]);
    await convergeSendFailureTasks(db, w.org, w.contact);
    expect(await w.open()).toHaveLength(2);
  });
});

describe("a falha não pode se perder: flags, erro e varredura de segurança", () => {
  it("canais desligados: a reivindicação é devolvida; ligadas depois, a varredura cria a tarefa (com as duas flags), só até 72 h", async () => {
    const w = await world({}); const c = await w.conv();
    const fresh = await w.msg(c, "mensagem recente que falhou no deploy", { at: ago(30) });
    const old = await w.msg(c, "mensagem antiga demais para recuperar", { at: new Date(NOW.getTime() - 80 * 3_600_000).toISOString() });
    for (const m of [fresh, old]) await reportSendFailure(db, { messageId: m, reason: "x" }, NOW);
    expect((await one("select metadata from messages where id=$1", [fresh])).metadata.send_failure_reported_at).toBeUndefined(); // devolvida
    expect((await one("select metadata from messages where id=$1", [fresh])).metadata.send_failed_at).toBeTruthy(); // continua marcada
    expect(await w.open()).toHaveLength(0);
    await pg.query("update organizations set settings=$2 where id=$1", [w.org, JSON.stringify({ send_failure_tasks_enabled: true })]);
    expect((await reconcileUnreportedSendFailures(db, { now: NOW })).reported).toBe(0); // falta a flag de varredura
    await pg.query("update organizations set settings=$2 where id=$1", [w.org, JSON.stringify({ send_failure_tasks_enabled: true, send_failure_reconcile_enabled: true })]);
    expect((await reconcileUnreportedSendFailures(db, { now: NOW })).reported).toBe(1);
    const open = await w.open(); expect(open).toHaveLength(1); expect(w.refs(open[0])).toEqual([fresh]); // a de 80 h ficou de fora
    expect((await reconcileUnreportedSendFailures(db, { now: NOW })).reported).toBe(0); // idempotente
  });
  it("erro ao criar a tarefa devolve a reivindicação: a falha pode ser refeita depois e não fica sem pendência", async () => {
    const w = await world(); const c = await w.conv(); const m = await w.msg(c, "mensagem que não conseguiu virar tarefa agora");
    const broken: any = { ...db, from: (t: string) => { const b = db.from(t); if (t === "tasks") b.insert = () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "boom" } }) }), then: (res: any) => res({ data: null, error: { message: "boom" } }) }); return b; } };
    const r = await reportSendFailure(broken, { messageId: m, reason: "x" }, NOW);
    expect(r.result?.skipped).toContain("error:task");
    expect(await w.open()).toHaveLength(0);
    expect((await one("select metadata from messages where id=$1", [m])).metadata.send_failure_reported_at).toBeUndefined();
    expect((await reportSendFailure(db, { messageId: m, reason: "x" }, NOW)).claim).toBe("claimed");
    expect(await w.open()).toHaveLength(1);
  });
  it("mensagem com mais de 120 min: sem push, mas a tarefa silenciosa existe (falha comercial relevante continua recuperável)", async () => {
    const w = await world({ send_failure_tasks_enabled: true, send_failure_alerts_enabled: true, push_notifications_enabled: true });
    const c = await w.conv(); const m = await w.msg(c, "mensagem de ontem à noite que falhou", { at: ago(60 * 20) });
    const r = await reportSendFailure(db, { messageId: m, reason: "x" }, NOW);
    expect(r.result?.skipped).toContain("stale_no_push"); expect(r.result?.sent).toBe(0); expect(r.result?.tasks).toBe(1);
  });
});

describe("encerramento só com evidência de recuperação (mensagens do inbox)", () => {
  it("reenvio do mesmo texto pelo vendedor recupera; mensagem genérica não; depois da recuperação uma nova falha abre nova tarefa", async () => {
    const w = await world(); const c = await w.conv();
    const text = "Segue a proposta de 90 mil, consegue confirmar hoje?";
    const failed = await w.msg(c, text, { at: ago(20) });
    await reportSendFailure(db, { messageId: failed, reason: "x" }, NOW);
    const hello = await w.msg(c, "Bom dia, tudo bem?", { at: ago(15), evo: "OK-1" });
    expect(await recoverSendFailures(db, w.org, w.contact, await w.accepted(hello))).toBe(0);
    expect(await w.open()).toHaveLength(1);
    const resend = await w.msg(c, text, { at: ago(5), evo: "OK-2" });
    expect(await recoverSendFailures(db, w.org, w.contact, await w.accepted(resend))).toBe(1);
    expect(await w.open()).toHaveLength(0);
    const next = await w.msg(c, "Outra mensagem comercial que também falhou", { at: ago(1) });
    await reportSendFailure(db, { messageId: next, reason: "x" }, NOW);
    expect(await w.open()).toHaveLength(1);
  });
  it("a MESMA mensagem reenviada com sucesso (reprocesso): a marca sai, a pendência fecha e o relato não volta", async () => {
    const w = await world(); const c = await w.conv(); const m = await w.msg(c, "[audio]", { media: "audio", meta: { source: "seller_audio" } });
    await reportSendFailure(db, { messageId: m, reason: "x" }, NOW);
    expect(await w.open()).toHaveLength(1);
    await setMessageEvolutionId(db, m, "EVO-LATE");
    expect(await recoverSendFailures(db, w.org, w.contact, await w.accepted(m))).toBe(1);
    expect(await w.open()).toHaveLength(0);
    expect((await one("select metadata from messages where id=$1", [m])).metadata.send_failed_at).toBeUndefined();
    expect((await reportSendFailure(db, { messageId: m, reason: "x" }, NOW)).claim).toBe("delivered");
  });
  it("áudio/anexo (sem texto) só fecha por id/resend_of ou manualmente; outra conversa do contato não fecha", async () => {
    const w = await world(); const a = await w.conv(); const b = await w.conv();
    const audio = await w.msg(a, "[audio]", { media: "audio", meta: { source: "seller_audio" }, at: ago(20) });
    await reportSendFailure(db, { messageId: audio, reason: "x" }, NOW);
    const again = await w.msg(a, "[audio]", { media: "audio", at: ago(5), evo: "A2" });
    expect(await recoverSendFailures(db, w.org, w.contact, await w.accepted(again))).toBe(0); // "[audio]" repetido não é evidência
    const other = await w.msg(b, "[audio]", { media: "audio", at: ago(4), evo: "B1", meta: { resend_of: audio } });
    expect(await recoverSendFailures(db, w.org, w.contact, await w.accepted(other))).toBe(0); // outra conversa
    const explicit = await w.msg(a, "reenvio do áudio", { at: ago(3), evo: "A3", meta: { resend_of: audio } });
    expect(await recoverSendFailures(db, w.org, w.contact, await w.accepted(explicit))).toBe(1);
    expect(await w.open()).toHaveLength(0);
  });
});

describe("peças do mecanismo", () => {
  it("claimSendFailureReport é atômico entre chamadas simultâneas e realSendFailureDeps expõe o contrato do alerta", async () => {
    const w = await world(); const c = await w.conv(); const m = await w.msg(c, "texto");
    const r = await Promise.all([1, 2, 3, 4].map(() => claimSendFailureReport(db, m, "x")));
    expect(r.filter((x) => x === "claimed")).toHaveLength(1);
    expect(Object.keys(realSendFailureDeps(db)).sort()).toEqual(["canReceivePush", "claim", "countRecentFailures", "createTask", "log", "managerIds", "release", "sendPush", "settings"]);
  });
});
