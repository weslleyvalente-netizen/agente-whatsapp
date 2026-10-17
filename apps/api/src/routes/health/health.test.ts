import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ getOrganizationById: vi.fn(), getOrComputeSnapshot: vi.fn() }));
vi.mock("@aula-agente/database", () => ({ getAdminClient: () => ({}), getOrganizationById: m.getOrganizationById }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async () => {} }));
vi.mock("../../services/health-monitor.js", () => ({ getOrComputeSnapshot: m.getOrComputeSnapshot }));
import Fastify from "fastify";
import routes from "./index.js";

const ORG = "22222222-2222-4222-8222-222222222222";
async function app(role: string | null) {
  const f = Fastify();
  f.addHook("preHandler", async (req: any) => { req.user = { id: "u", email: "x", memberships: role ? [{ organization_id: ORG, role }] : [] }; });
  await f.register(routes);
  return f;
}
beforeEach(() => {
  vi.clearAllMocks();
  m.getOrganizationById.mockResolvedValue({ settings: {} });
  m.getOrComputeSnapshot.mockResolvedValue({
    status: "warning", reasons: ["Redis fora do ar"], lastCustomerMessageAt: "2026-10-16T23:00:00.000Z",
    redis: "down", evolution: "connected", checkedAt: "2026-10-17T10:00:00.000Z",
  });
});

describe("GET /organizations/:id/health", () => {
  it("membro (inclusive agent) recebe o estado, sem campos internos", async () => {
    const res = await (await app("agent")).inject({ method: "GET", url: `/organizations/${ORG}/health` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "warning", reasons: ["Redis fora do ar"], lastCustomerMessageAt: "2026-10-16T23:00:00.000Z", redis: "down", evolution: "connected" });
  });
  it("não-membro recebe 403", async () => {
    expect((await (await app(null)).inject({ method: "GET", url: `/organizations/${ORG}/health` })).statusCode).toBe(403);
  });
  it("id inválido devolve 400", async () => {
    expect((await (await app("owner")).inject({ method: "GET", url: "/organizations/abc/health" })).statusCode).toBe(400);
  });
});
