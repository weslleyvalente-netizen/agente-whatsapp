import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})), upsertPushSubscription: vi.fn(), deletePushSubscription: vi.fn(),
  sendPushToUser: vi.fn(), isPushConfigured: vi.fn(() => true),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (req: any, reply: any) => {
    if (!req.headers.authorization) return reply.status(401).send({ error: "no auth" });
    req.user = { id: "u1", email: "x", memberships: [{ organization_id: ORG, role: "agent" }] };
  },
}));
import Fastify from "fastify";
import routes from "./index.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const auth = { authorization: "Bearer t" };
const body = { organizationId: ORG, endpoint: "https://push.example/abc", keys: { p256dh: "pk", auth: "ak" } };
async function app() { const f = Fastify(); await f.register(routes); return f; }

beforeEach(() => {
  vi.clearAllMocks();
  m.upsertPushSubscription.mockResolvedValue("ok");
  m.isPushConfigured.mockReturnValue(true);
  process.env.VAPID_PUBLIC_KEY = "PUB";
});

describe("GET /push/public-key", () => {
  it("exige autenticação", async () => {
    expect((await (await app()).inject({ method: "GET", url: "/push/public-key" })).statusCode).toBe(401);
  });
  it("devolve a chave pública; sem chaves devolve null (recurso inerte, sem erro)", async () => {
    const res = await (await app()).inject({ method: "GET", url: "/push/public-key", headers: auth });
    expect(res.json()).toEqual({ publicKey: "PUB" });
    m.isPushConfigured.mockReturnValue(false);
    const off = await (await app()).inject({ method: "GET", url: "/push/public-key", headers: auth });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ publicKey: null });
  });
});

describe("POST /push/subscribe", () => {
  it("exige autenticação", async () => {
    expect((await (await app()).inject({ method: "POST", url: "/push/subscribe", payload: body })).statusCode).toBe(401);
  });
  it("faz upsert da assinatura do próprio usuário", async () => {
    const res = await (await app()).inject({ method: "POST", url: "/push/subscribe", headers: { ...auth, "user-agent": "UA" }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(m.upsertPushSubscription).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, userId: "u1", endpoint: body.endpoint, p256dh: "pk", auth: "ak", userAgent: "UA" });
  });
  it("endpoint vinculado a outro usuário com chaves diferentes devolve 409", async () => {
    m.upsertPushSubscription.mockResolvedValueOnce("conflict");
    const res = await (await app()).inject({ method: "POST", url: "/push/subscribe", headers: auth, payload: body });
    expect(res.statusCode).toBe(409);
  });
  it("recusa organização da qual o usuário não é membro", async () => {
    const res = await (await app()).inject({ method: "POST", url: "/push/subscribe", headers: auth, payload: { ...body, organizationId: OTHER_ORG } });
    expect(res.statusCode).toBe(403);
    expect(m.upsertPushSubscription).not.toHaveBeenCalled();
  });
  it("recusa corpo inválido", async () => {
    const res = await (await app()).inject({ method: "POST", url: "/push/subscribe", headers: auth, payload: { organizationId: ORG, endpoint: "http://insecure", keys: {} } });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /push/unsubscribe", () => {
  it("remove só do próprio usuário", async () => {
    const res = await (await app()).inject({ method: "POST", url: "/push/unsubscribe", headers: auth, payload: { endpoint: body.endpoint } });
    expect(res.statusCode).toBe(200);
    expect(m.deletePushSubscription).toHaveBeenCalledWith(expect.anything(), "u1", body.endpoint);
  });
});

describe("POST /push/test", () => {
  it("envia o teste ao próprio usuário", async () => {
    m.sendPushToUser.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
    const res = await (await app()).inject({ method: "POST", url: "/push/test", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(m.sendPushToUser).toHaveBeenCalledWith(expect.anything(), "u1", expect.objectContaining({ title: expect.any(String), url: "/" }));
    expect(res.json()).toMatchObject({ sent: 1 });
  });
  it("sem chaves VAPID responde 503 sem enviar", async () => {
    m.isPushConfigured.mockReturnValue(false);
    const res = await (await app()).inject({ method: "POST", url: "/push/test", headers: auth });
    expect(res.statusCode).toBe(503);
    expect(m.sendPushToUser).not.toHaveBeenCalled();
  });
});
