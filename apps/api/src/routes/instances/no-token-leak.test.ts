import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "u1", memberships: [{ organization_id: "org-1", role: "admin" }] }; } }));
const row = { id: "i1", organization_id: "org-1", instance_name: "w", instance_id: "w", status: "connected", phone_number: "1", provider: "uazapi", provider_token_encrypted: "aa:bb:cc" };
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}), getInstancesByOrganization: async () => [row], getInstanceById: async () => row,
  updateInstance: async () => row, createInstance: async () => row, deleteInstance: async () => undefined,
}));
vi.mock("../../services/evolution.service.js", () => ({
  createInstance: async () => ({}), getInstanceStatus: async () => ({ instance: { state: "open", phoneNumber: "1" } }),
  getInstanceQrCode: async () => ({}), deleteInstance: async () => undefined, logoutInstance: async () => undefined,
}));
import routes from "./index.js";

async function call(method: "GET" | "PATCH", url: string, payload?: object) {
  const app = Fastify(); await app.register(routes); const r = await app.inject({ method, url, payload }); await app.close(); return r;
}

describe("rotas de instância não devolvem o token cifrado", () => {
  it("listar, estado e editar", async () => {
    for (const r of [await call("GET", "/organizations/org-1/instances"), await call("GET", "/instances/i1/status"), await call("PATCH", "/instances/i1", { active_agent_id: null })]) {
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain("provider_token_encrypted");
      expect(r.body).toContain("uazapi");
    }
  });
});
