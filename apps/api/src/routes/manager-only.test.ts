import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const state = vi.hoisted(() => ({ role: "agent" }));
const db = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  getAgentById: vi.fn(),
  getInstanceById: vi.fn(),
  getAgentMessagesForCost: vi.fn(async () => []),
  getAiUsageEventsForCost: vi.fn(async () => []),
  patchAgentConfig: vi.fn(async () => ({ id: "draft" })),
}));
// Qualquer outra função do pacote vira stub (os módulos importam muitas).
vi.mock("@aula-agente/database", () => new Proxy({}, { has: () => true, get: (_t, k: string | symbol) => (typeof k === "symbol" || k === "then" || k === "__esModule" ? undefined : k in db ? (db as any)[k] : vi.fn()) }));
vi.mock("../services/agent-config.service.js", () => ({
  getAgentConfigWithStatus: vi.fn(async () => ({ ok: true })), publishDraft: vi.fn(), discardDraft: vi.fn(), listVersions: vi.fn(async () => []), getVersionWithDiff: vi.fn(), restoreVersion: vi.fn(),
}));
vi.mock("../services/playground.service.js", () => ({ sendPlaygroundMessage: vi.fn() }));
vi.mock("../services/import-suggestion.service.js", () => ({ suggestConfigFromSystemPrompt: vi.fn() }));
vi.mock("../services/trainer.service.js", () => ({ proposeConfigChange: vi.fn() }));
vi.mock("../services/trainer-decisions.service.js", () => ({ applyTrainerProposal: vi.fn(), rejectTrainerProposal: vi.fn() }));
vi.mock("../services/evolution.service.js", () => ({ getInstanceQrCode: vi.fn(async () => ({ code: "qr" })) }));
vi.mock("../lib/fx-rates.js", () => ({ getUsdBrlRates: vi.fn(async () => new Map()), rateOnOrBefore: vi.fn() }));
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "u1", email: "u@x.com", memberships: [{ organization_id: "org-1", role: state.role }] };
  },
}));

import agentConfigRoutes from "./agent-config/index.js";
import costRoutes from "./costs/index.js";
import instanceRoutes from "./instances/index.js";

const requests = [
  { name: "config do agente (GET)", method: "GET", url: "/agents/a1/config" },
  { name: "config do agente (PATCH)", method: "PATCH", url: "/agents/a1/config", payload: { system_prompt: "x" } },
  { name: "publicar", method: "POST", url: "/agents/a1/config/publish", payload: { changelog: "x" } },
  { name: "versões", method: "GET", url: "/agents/a1/versions" },
  { name: "custos", method: "GET", url: "/organizations/org-1/costs/summary" },
  { name: "QR code", method: "GET", url: "/instances/i1/qrcode" },
] as const;

describe("rotas de configuração/custos exigem owner/admin", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    db.getAgentById.mockResolvedValue({ id: "a1", organization_id: "org-1" });
    db.getInstanceById.mockResolvedValue({ id: "i1", organization_id: "org-1", instance_name: "n" });
    app = Fastify();
    await app.register(agentConfigRoutes); await app.register(costRoutes); await app.register(instanceRoutes);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it.each(requests)("vendedor recebe 403 em $name", async (r) => {
    state.role = "agent";
    const res = await app.inject({ method: r.method, url: r.url, payload: (r as any).payload });
    expect(res.statusCode, res.body).toBe(403);
  });
  it.each(requests)("admin passa em $name", async (r) => {
    state.role = "admin";
    const res = await app.inject({ method: r.method, url: r.url, payload: (r as any).payload });
    expect(res.statusCode).not.toBe(403);
  });
  it("dono também passa nos custos", async () => {
    state.role = "owner";
    expect((await app.inject({ method: "GET", url: "/organizations/org-1/costs/summary" })).statusCode).toBe(200);
  });
});
