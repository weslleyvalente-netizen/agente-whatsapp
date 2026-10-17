import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getInstancesByOrganization: vi.fn(),
  messageExistsByEvolutionId: vi.fn(),
  findReceivedMessages: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  getInstancesByOrganization: m.getInstancesByOrganization,
  messageExistsByEvolutionId: m.messageExistsByEvolutionId,
}));
vi.mock("../../services/evolution.service.js", () => ({ findReceivedMessages: m.findReceivedMessages }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async () => {} }));

import Fastify from "fastify";
import routes, { recoveryConfig } from "./recover-messages.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const SECRET = "super-secret-webhook";
const delivered: Array<{ id: string; headers: Record<string, unknown>; body: any }> = [];
let webhookBehavior: (id: string) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

async function app(role: string | null) {
  const f = Fastify();
  f.addHook("preHandler", async (req: any) => {
    req.user = { id: "u1", email: "x", memberships: role ? [{ organization_id: ORG, role }] : [] };
  });
  f.post("/webhooks/evolution", async (req, reply) => {
    const body = req.body as any;
    delivered.push({ id: body.data.key.id, headers: req.headers, body });
    const r = webhookBehavior(body.data.key.id);
    return reply.status(r.status).send(r.body);
  });
  await f.register(routes);
  return f;
}

const rec = (id: string, ts: number, jid = "5511999990001@s.whatsapp.net", extra: Record<string, unknown> = {}) => ({
  key: { remoteJid: jid, fromMe: false, id },
  pushName: "Cliente",
  message: { conversation: `texto secreto ${id}` },
  messageType: "conversation",
  messageTimestamp: ts,
  ...extra,
});

const url = `/organizations/${ORG}/admin/recover-messages`;
const SINCE = "2026-10-16T23:00:00.000Z";
const UNTIL = "2026-10-17T11:45:00.000Z";
const T0 = Date.parse(SINCE) / 1000;

beforeEach(() => {
  vi.clearAllMocks();
  delivered.length = 0;
  recoveryConfig.delayMs = 0;
  process.env.WEBHOOK_SECRET = SECRET;
  webhookBehavior = () => ({ status: 200, body: { ok: true } });
  m.getInstancesByOrganization.mockResolvedValue([{ id: "i1", instance_name: "inst-a", instance_id: "inst-a", active_agent_id: "ag" }]);
  m.messageExistsByEvolutionId.mockResolvedValue(false);
  m.findReceivedMessages.mockResolvedValue([]);
});

describe("recover-messages: permissão e validação", () => {
  it("agent recebe 403 e nada é buscado", async () => {
    const res = await (await app("agent")).inject({ method: "POST", url, payload: { since: SINCE } });
    expect(res.statusCode).toBe(403);
    expect(m.findReceivedMessages).not.toHaveBeenCalled();
  });
  it("não-membro recebe 403", async () => {
    expect((await (await app(null)).inject({ method: "POST", url, payload: { since: SINCE } })).statusCode).toBe(403);
  });
  it("owner e admin passam", async () => {
    expect((await (await app("owner")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL } })).statusCode).toBe(200);
    expect((await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL } })).statusCode).toBe(200);
  });
  it("janela maior que 7 dias devolve 400", async () => {
    const res = await (await app("admin")).inject({ method: "POST", url, payload: { since: "2026-10-01T00:00:00Z", until: "2026-10-17T00:00:00Z" } });
    expect(res.statusCode).toBe(400);
    expect(m.findReceivedMessages).not.toHaveBeenCalled();
  });
  it("since ausente, inválido, ou until antes de since devolve 400", async () => {
    const a = await app("admin");
    expect((await a.inject({ method: "POST", url, payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url, payload: { since: "ontem" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url, payload: { since: UNTIL, until: SINCE } })).statusCode).toBe(400);
  });
  it("organizationId que não é UUID devolve 400", async () => {
    const res = await (await app("admin")).inject({ method: "POST", url: "/organizations/org/admin/recover-messages", payload: { since: SINCE } });
    expect(res.statusCode).toBe(400);
  });
});

describe("recover-messages: dryRun e classificação", () => {
  beforeEach(() => {
    m.findReceivedMessages.mockResolvedValue([
      rec("A1", T0 + 10),
      rec("A2", T0 + 20),
      rec("B1", T0 + 15, "5511988887777@s.whatsapp.net"),
      rec("G1", T0 + 30, "120363000000000000@g.us"),
      rec("R1", T0 + 40, undefined, { messageType: "reactionMessage" }),
      rec("DUP", T0 + 50),
    ]);
    m.messageExistsByEvolutionId.mockImplementation(async (_db: unknown, id: string) => id === "DUP");
  });

  it("dryRun é o padrão: conta tudo e não envia nada ao webhook", async () => {
    const res = await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL } });
    const body = res.json();
    expect(body).toMatchObject({
      dryRun: true, instance: "inst-a", fetched: 6, alreadyInCrm: 1, toRecover: 3, customers: 2, replayed: 0, failed: 0,
      skipped: { groups: 1, nonContent: 1 },
    });
    expect(delivered).toHaveLength(0);
  });

  it("amostra só com últimos 4 dígitos e sem texto", async () => {
    const res = await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: true } });
    const raw = res.body;
    expect(res.json().sample).toEqual(expect.arrayContaining([
      expect.objectContaining({ phoneLast4: "0001", count: 2 }),
      expect.objectContaining({ phoneLast4: "7777", count: 1 }),
    ]));
    expect(raw).not.toContain("5511999990001");
    expect(raw).not.toContain("5511988887777");
    expect(raw).not.toContain("texto secreto");
    expect(raw).not.toContain(SECRET);
  });
});

describe("recover-messages: reenvio", () => {
  it("reenvia em ordem cronológica pelo webhook, com apikey, cabeçalho de replay e payload válido", async () => {
    m.findReceivedMessages.mockResolvedValue([rec("C", T0 + 300), rec("A", T0 + 100), rec("B", T0 + 200)]);
    const res = await (await app("owner")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: false } });
    expect(res.json()).toMatchObject({ dryRun: false, toRecover: 3, replayed: 3, failed: 0 });
    expect(delivered.map((d) => d.id)).toEqual(["A", "B", "C"]);
    expect(delivered[0].headers.apikey).toBe(SECRET);
    expect(delivered[0].headers["x-replay-original-timestamp"]).toBe("1");
    expect(delivered[0].body).toMatchObject({
      event: "messages.upsert", instance: "inst-a",
      data: { key: { id: "A", fromMe: false }, messageType: "conversation", messageTimestamp: T0 + 100 },
    });
  });

  it("falha de uma mensagem não interrompe as outras e é contada", async () => {
    m.findReceivedMessages.mockResolvedValue([rec("A", T0 + 1), rec("B", T0 + 2), rec("C", T0 + 3)]);
    webhookBehavior = (id) => (id === "B" ? { status: 500, body: { error: "boom com texto secreto" } } : { status: 200, body: { ok: true } });
    const res = await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: false } });
    expect(res.json()).toMatchObject({ replayed: 2, failed: 1 });
    expect(delivered.map((d) => d.id)).toEqual(["A", "B", "C"]);
    expect(res.body).not.toContain("boom");
  });

  it("webhook que responde duplicate conta como já no CRM, não como reenviada", async () => {
    m.findReceivedMessages.mockResolvedValue([rec("A", T0 + 1)]);
    webhookBehavior = () => ({ status: 200, body: { ok: true, skipped: "duplicate" } });
    const body = (await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: false } })).json();
    expect(body).toMatchObject({ replayed: 0, failed: 0, alreadyInCrm: 1 });
  });

  it("skipped human_takeover conta como recuperada (a mensagem foi gravada); unknown_instance como falha", async () => {
    m.findReceivedMessages.mockResolvedValue([rec("A", T0 + 1), rec("B", T0 + 2)]);
    webhookBehavior = (id) => ({ status: 200, body: { ok: true, skipped: id === "A" ? "human_takeover" : "unknown_instance" } });
    const body = (await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: false } })).json();
    expect(body).toMatchObject({ replayed: 1, failed: 1 });
  });

  it("idempotente: segunda execução, com tudo já gravado, não reenvia nada", async () => {
    m.findReceivedMessages.mockResolvedValue([rec("A", T0 + 1), rec("B", T0 + 2)]);
    const a = await app("admin");
    await a.inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: false } });
    expect(delivered).toHaveLength(2);
    m.messageExistsByEvolutionId.mockResolvedValue(true);
    const second = (await a.inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: false } })).json();
    expect(second).toMatchObject({ alreadyInCrm: 2, toRecover: 0, replayed: 0 });
    expect(delivered).toHaveLength(2);
  });

  it("ids repetidos na resposta da Evolution são enviados uma vez só", async () => {
    m.findReceivedMessages.mockResolvedValue([rec("A", T0 + 1), rec("A", T0 + 1)]);
    await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: false } });
    expect(delivered).toHaveLength(1);
  });

  it("payload inválido para o schema do webhook conta como falha sem enviar", async () => {
    m.findReceivedMessages.mockResolvedValue([rec("A", T0 + 1, undefined, { messageType: undefined })]);
    const body = (await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL, dryRun: false } })).json();
    expect(body).toMatchObject({ failed: 1, replayed: 0 });
    expect(delivered).toHaveLength(0);
  });

  it("erro ao consultar a Evolution devolve 502 sem vazar detalhes", async () => {
    m.findReceivedMessages.mockRejectedValue(new Error("Evolution API error 500: apikey=abc123"));
    const res = await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL } });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("abc123");
  });

  it("sem instância com agente devolve 409", async () => {
    m.getInstancesByOrganization.mockResolvedValue([{ id: "i1", instance_name: "x", instance_id: "x", active_agent_id: null }]);
    expect((await (await app("admin")).inject({ method: "POST", url, payload: { since: SINCE, until: UNTIL } })).statusCode).toBe(409);
  });
});
