import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getInstancesByOrganization: vi.fn(),
  findExistingEvolutionMessageIds: vi.fn(),
  getLastOutboundAtForPhone: vi.fn(),
  findStoredMessages: vi.fn(),
  probeRedis: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  getInstancesByOrganization: m.getInstancesByOrganization,
  findExistingEvolutionMessageIds: m.findExistingEvolutionMessageIds,
  getLastOutboundAtForPhone: m.getLastOutboundAtForPhone,
}));
vi.mock("../../services/evolution.service.js", () => ({ findStoredMessages: m.findStoredMessages }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async () => {} }));
vi.mock("../../lib/redis-probe.js", () => ({ probeRedis: m.probeRedis }));

import Fastify from "fastify";
import routes, { recoveryConfig, resetRecoveryState, waitForRecoveryIdle } from "./recover-messages.js";
import { REPLAY_TOKEN } from "../../lib/replay-token.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const SECRET = "super-secret-webhook";
const delivered: Array<{ id: string; at: number; headers: Record<string, unknown>; body: any }> = [];
let webhookBehavior: (id: string) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

async function app(role: string | null) {
  const f = Fastify();
  f.addHook("preHandler", async (req: any) => {
    req.user = { id: "u1", email: "x", memberships: role ? [{ organization_id: ORG, role }] : [] };
  });
  f.post("/webhooks/evolution", async (req, reply) => {
    const body = req.body as any;
    delivered.push({ id: body.data.key.id, at: Date.now(), headers: req.headers, body });
    const r = await webhookBehavior(body.data.key.id);
    return reply.status(r.status).send(r.body);
  });
  await f.register(routes);
  return f;
}

const J1 = "5511999990001@s.whatsapp.net";
const J2 = "5511988887777@s.whatsapp.net";
const rec = (id: string, ts: number, jid = J1, extra: Record<string, unknown> = {}) => ({
  key: { remoteJid: jid, fromMe: false, id },
  pushName: "Cliente",
  message: { conversation: `texto secreto ${id}` },
  messageType: "conversation",
  messageTimestamp: ts,
  ...extra,
});
const sentRec = (id: string, ts: number, jid = J1) => ({ ...rec(id, ts, jid), key: { remoteJid: jid, fromMe: true, id } });

let received: any[] = [];
let sent: any[] = [];

const url = `/organizations/${ORG}/admin/recover-messages`;
const statusUrl = `${url}/status`;
const SINCE = "2026-10-16T23:00:00.000Z";
const UNTIL = "2026-10-17T11:45:00.000Z";
const T0 = Date.parse(SINCE) / 1000;
const post = (a: any, payload: any) => a.inject({ method: "POST", url, payload });

async function runAndWait(a: any, payload: any = {}) {
  const res = await post(a, { since: SINCE, until: UNTIL, dryRun: false, ...payload });
  expect(res.statusCode).toBe(202);
  for (let i = 0; i < 400; i++) {
    const st = (await a.inject({ method: "GET", url: statusUrl })).json();
    if (st.state !== "running") return st;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("run did not finish");
}

beforeEach(async () => {
  await waitForRecoveryIdle();
  vi.clearAllMocks();
  resetRecoveryState();
  delivered.length = 0;
  received = []; sent = [];
  recoveryConfig.intraMs = 0; recoveryConfig.interMs = 0; recoveryConfig.injectTimeoutMs = 30_000;
  process.env.WEBHOOK_SECRET = SECRET;
  webhookBehavior = () => ({ status: 200, body: { ok: true } });
  m.getInstancesByOrganization.mockResolvedValue([{ id: "i1", instance_name: "inst-a", instance_id: "inst-a", active_agent_id: "ag" }]);
  m.findExistingEvolutionMessageIds.mockImplementation(async () => new Set<string>());
  m.getLastOutboundAtForPhone.mockResolvedValue(null);
  m.probeRedis.mockResolvedValue(true);
  m.findStoredMessages.mockImplementation(async (_i: string, _w: unknown, fromMe: boolean) => (fromMe ? sent : received));
});

describe("permissão e validação", () => {
  it("agent recebe 403 em POST e GET status", async () => {
    const a = await app("agent");
    expect((await post(a, { since: SINCE })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: statusUrl })).statusCode).toBe(403);
    expect(m.findStoredMessages).not.toHaveBeenCalled();
  });
  it("não-membro recebe 403", async () => {
    const a = await app(null);
    expect((await post(a, { since: SINCE })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: statusUrl })).statusCode).toBe(403);
  });
  it("owner e admin passam; status ocioso", async () => {
    expect((await post(await app("owner"), { since: SINCE, until: UNTIL })).statusCode).toBe(200);
    const a = await app("admin");
    expect((await post(a, { since: SINCE, until: UNTIL })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: statusUrl })).json()).toEqual({ state: "idle" });
  });
  it("janela > 7 dias, since inválido e until antes de since devolvem 400", async () => {
    const a = await app("admin");
    expect((await post(a, { since: "2026-10-01T00:00:00Z", until: "2026-10-17T00:00:00Z" })).statusCode).toBe(400);
    expect((await post(a, {})).statusCode).toBe(400);
    expect((await post(a, { since: "ontem" })).statusCode).toBe(400);
    expect((await post(a, { since: UNTIL, until: SINCE })).statusCode).toBe(400);
    expect(m.findStoredMessages).not.toHaveBeenCalled();
  });
  it("organizationId que não é UUID devolve 400", async () => {
    const res = await (await app("admin")).inject({ method: "POST", url: "/organizations/org/admin/recover-messages", payload: { since: SINCE } });
    expect(res.statusCode).toBe(400);
  });
  it("sem instância com agente devolve 409", async () => {
    m.getInstancesByOrganization.mockResolvedValue([{ id: "i1", instance_name: "x", instance_id: "x", active_agent_id: null }]);
    expect((await post(await app("admin"), { since: SINCE, until: UNTIL })).statusCode).toBe(409);
  });
});

describe("dryRun e classificação", () => {
  beforeEach(() => {
    received = [
      rec("A1", T0 + 10), rec("A2", T0 + 20), rec("B1", T0 + 15, J2),
      rec("G1", T0 + 30, "120363000000000000@g.us"),
      rec("R1", T0 + 40, J1, { messageType: "reactionMessage" }),
      rec("DUP", T0 + 50),
    ];
    m.findExistingEvolutionMessageIds.mockImplementation(async (_db: unknown, ids: string[]) => new Set(ids.filter((i) => i === "DUP")));
  });

  it("dryRun é o padrão: conta tudo e não envia nada; dedupe em lote (1 chamada)", async () => {
    const res = await post(await app("admin"), { since: SINCE, until: UNTIL });
    expect(res.json()).toMatchObject({
      dryRun: true, instance: "inst-a", fetched: 6, alreadyInCrm: 1, toRecover: 3, customers: 2, replayed: 0, failed: 0,
      answeredCustomers: 0, skippedAnswered: 0, skipped: { groups: 1, nonContent: 1 },
    });
    expect(delivered).toHaveLength(0);
    expect(m.findExistingEvolutionMessageIds).toHaveBeenCalledTimes(1);
  });

  it("amostra só com últimos 4 dígitos e sem texto nem segredos", async () => {
    const res = await post(await app("admin"), { since: SINCE, until: UNTIL, dryRun: true });
    expect(res.json().sample).toEqual(expect.arrayContaining([
      expect.objectContaining({ phoneLast4: "0001", count: 2 }),
      expect.objectContaining({ phoneLast4: "7777", count: 1 }),
    ]));
    for (const s of ["5511999990001", "5511988887777", "texto secreto", SECRET]) expect(res.body).not.toContain(s);
  });

  it("erro da Evolution na análise devolve 502 sem vazar detalhes", async () => {
    m.findStoredMessages.mockRejectedValue(new Error("Evolution API error 500: apikey=abc123"));
    const res = await post(await app("admin"), { since: SINCE, until: UNTIL });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("abc123");
  });
});

describe("fromMe: clientes já respondidos", () => {
  beforeEach(() => {
    received = [rec("A1", T0 + 10, J1), rec("A2", T0 + 20, J1), rec("B1", T0 + 15, J2)];
    sent = [sentRec("H1", T0 + 100, J1)]; // alguém respondeu o cliente 1 depois da última mensagem perdida
  });
  it("dry-run conta clientes respondidos e não os inclui no reenvio", async () => {
    const body = (await post(await app("admin"), { since: SINCE, until: UNTIL })).json();
    expect(body).toMatchObject({ answeredCustomers: 1, skippedAnswered: 2, toRecover: 1, customers: 1 });
    expect(body.note).toContain("já foram respondidos");
  });
  it("resposta ANTES da última mensagem perdida não conta como respondido", async () => {
    sent = [sentRec("H1", T0 + 12, J1)];
    expect((await post(await app("admin"), { since: SINCE, until: UNTIL })).json()).toMatchObject({ answeredCustomers: 0, toRecover: 3 });
  });
  it("reenvio real pula os respondidos por padrão", async () => {
    const st = await runAndWait(await app("admin"));
    expect(delivered.map((d) => d.id)).toEqual(["B1"]);
    expect(st).toMatchObject({ state: "done", total: 1, replayed: 1 });
  });
  it("includeAnswered:true reenvia também os respondidos", async () => {
    await runAndWait(await app("admin"), { includeAnswered: true });
    expect(delivered.map((d) => d.id).sort()).toEqual(["A1", "A2", "B1"]);
  });
});

describe("salvas sem resposta nova da IA", () => {
  it("conta mensagens com horário anterior a uma resposta nossa já existente", async () => {
    received = [rec("A1", T0 + 10), rec("A2", T0 + 5000)];
    m.getLastOutboundAtForPhone.mockResolvedValue(new Date((T0 + 1000) * 1000).toISOString());
    const body = (await post(await app("admin"), { since: SINCE, until: UNTIL })).json();
    expect(body.savedNoAiReply).toBe(1);
    expect(body.note).toContain("sem resposta nova da IA");
  });
});

describe("reenvio em segundo plano", () => {
  it("devolve 202 {runId} e o status mostra o resumo final", async () => {
    received = [rec("C", T0 + 300), rec("A", T0 + 100), rec("B", T0 + 200)];
    const a = await app("owner");
    const res = await post(a, { since: SINCE, until: UNTIL, dryRun: false });
    expect(res.statusCode).toBe(202);
    expect(res.json().runId).toEqual(expect.any(String));
    let st: any;
    for (let i = 0; i < 400; i++) { st = (await a.inject({ method: "GET", url: statusUrl })).json(); if (st.state !== "running") break; await new Promise((r) => setTimeout(r, 5)); }
    expect(st).toMatchObject({ state: "done", total: 3, done: 3, replayed: 3, failed: 0, runId: res.json().runId });
    expect(st.finishedAt).toEqual(expect.any(String));
    expect(delivered.map((d) => d.id)).toEqual(["A", "B", "C"]);
    expect(delivered[0].headers.apikey).toBe(SECRET);
    expect(delivered[0].headers["x-replay-original-timestamp"]).toBe(REPLAY_TOKEN);
    expect(delivered[0].body).toMatchObject({ event: "messages.upsert", instance: "inst-a", data: { key: { id: "A", fromMe: false }, messageTimestamp: T0 + 100 } });
    expect(JSON.stringify(st)).not.toMatch(/texto secreto|5511999990001/);
  });

  it("progresso aparece enquanto roda", async () => {
    received = [rec("A", T0 + 1), rec("B", T0 + 2)];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    webhookBehavior = async (id) => { if (id === "B") await gate; return { status: 200, body: { ok: true } }; };
    const a = await app("admin");
    await post(a, { since: SINCE, until: UNTIL, dryRun: false });
    let st: any;
    for (let i = 0; i < 400; i++) { st = (await a.inject({ method: "GET", url: statusUrl })).json(); if (st.done >= 1) break; await new Promise((r) => setTimeout(r, 5)); }
    expect(st).toMatchObject({ state: "running", total: 2, done: 1 });
    // segundo disparo durante a execução é recusado
    expect((await post(a, { since: SINCE, until: UNTIL, dryRun: false })).statusCode).toBe(409);
    release();
    for (let i = 0; i < 400; i++) { st = (await a.inject({ method: "GET", url: statusUrl })).json(); if (st.state !== "running") break; await new Promise((r) => setTimeout(r, 5)); }
    expect(st.state).toBe("done");
    // lock liberado: novo disparo aceito
    expect((await post(a, { since: SINCE, until: UNTIL, dryRun: false })).statusCode).toBe(202);
  });

  it("Redis fora do ar: 503 e nada é enviado nem fica travado", async () => {
    received = [rec("A", T0 + 1)];
    m.probeRedis.mockResolvedValue(false);
    const a = await app("admin");
    expect((await post(a, { since: SINCE, until: UNTIL, dryRun: false })).statusCode).toBe(503);
    expect(delivered).toHaveLength(0);
    m.probeRedis.mockResolvedValue(true);
    expect((await post(a, { since: SINCE, until: UNTIL, dryRun: false })).statusCode).toBe(202);
  });

  it("inject pendurado vira falha após o timeout e o lote continua; lock liberado", async () => {
    received = [rec("A", T0 + 1), rec("B", T0 + 2)];
    recoveryConfig.injectTimeoutMs = 40;
    webhookBehavior = (id) => (id === "A" ? new Promise(() => {}) : { status: 200, body: { ok: true } });
    const a = await app("admin");
    const st = await runAndWait(a);
    expect(st).toMatchObject({ state: "done", replayed: 1, failed: 1 });
    expect((await post(a, { since: SINCE, until: UNTIL, dryRun: false })).statusCode).toBe(202);
  });

  it("agrupa por cliente: mensagens do cliente seguidas, depois espera antes do próximo (ordem pela primeira mensagem)", async () => {
    received = [rec("A1", T0 + 1, J1), rec("B1", T0 + 2, J2), rec("A2", T0 + 3, J1), rec("B2", T0 + 4, J2)];
    recoveryConfig.interMs = 60;
    await runAndWait(await app("admin"));
    expect(delivered.map((d) => d.id)).toEqual(["A1", "A2", "B1", "B2"]);
    const gapInside = delivered[1].at - delivered[0].at;
    const gapBetween = delivered[2].at - delivered[1].at;
    expect(gapBetween).toBeGreaterThanOrEqual(55);
    expect(gapInside).toBeLessThan(gapBetween);
  });

  it("falha isolada não interrompe e é contada, sem vazar o erro", async () => {
    received = [rec("A", T0 + 1), rec("B", T0 + 2), rec("C", T0 + 3)];
    webhookBehavior = (id) => (id === "B" ? { status: 500, body: { error: "boom com texto secreto" } } : { status: 200, body: { ok: true } });
    const st = await runAndWait(await app("admin"));
    expect(st).toMatchObject({ replayed: 2, failed: 1 });
    expect(delivered.map((d) => d.id)).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(st)).not.toContain("boom");
  });

  it("duplicate conta como já no CRM; human_takeover como recuperada; unknown_instance como falha", async () => {
    received = [rec("A", T0 + 1), rec("B", T0 + 2), rec("C", T0 + 3)];
    webhookBehavior = (id) => ({ status: 200, body: { ok: true, skipped: id === "A" ? "duplicate" : id === "B" ? "human_takeover" : "unknown_instance" } });
    const st = await runAndWait(await app("admin"));
    expect(st).toMatchObject({ replayed: 1, failed: 1 });
    expect(st.summary.alreadyInCrm).toBe(1);
  });

  it("idempotente: com tudo já gravado, nada é reenviado", async () => {
    received = [rec("A", T0 + 1), rec("B", T0 + 2)];
    m.findExistingEvolutionMessageIds.mockImplementation(async (_db: unknown, ids: string[]) => new Set(ids));
    const st = await runAndWait(await app("admin"));
    expect(st).toMatchObject({ total: 0, replayed: 0 });
    expect(st.summary.alreadyInCrm).toBe(2);
    expect(delivered).toHaveLength(0);
  });

  it("ids repetidos na resposta da Evolution são enviados uma vez só", async () => {
    received = [rec("A", T0 + 1), rec("A", T0 + 1)];
    await runAndWait(await app("admin"));
    expect(delivered).toHaveLength(1);
  });

  it("payload inválido para o schema do webhook conta como falha sem enviar", async () => {
    received = [rec("A", T0 + 1, J1, { messageType: undefined })];
    const st = await runAndWait(await app("admin"));
    expect(st).toMatchObject({ failed: 1, replayed: 0 });
    expect(delivered).toHaveLength(0);
  });

  it("erro na análise em segundo plano marca failed e libera o lock", async () => {
    m.findStoredMessages.mockRejectedValueOnce(new Error("apikey=abc123"));
    const a = await app("admin");
    const st = await runAndWait(a);
    expect(st.state).toBe("failed");
    expect(JSON.stringify(st)).not.toContain("abc123");
    expect((await post(a, { since: SINCE, until: UNTIL, dryRun: false })).statusCode).toBe(202);
  });
});
