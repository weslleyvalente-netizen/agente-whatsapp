import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  role: { value: "admin" }, instance: {} as Record<string, unknown>,
  setFields: vi.fn(), create: vi.fn(), setWebhook: vi.fn(), connect: vi.fn(), status: vi.fn(), resetCache: vi.fn(),
}));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "u1", memberships: [{ organization_id: "org-1", role: m.role.value }] }; } }));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  getInstanceById: async () => m.instance,
  setInstanceProviderFields: m.setFields,
}));
vi.mock("@aula-agente/agent-runtime", async () => {
  const real = await vi.importActual<typeof import("@aula-agente/agent-runtime")>("@aula-agente/agent-runtime");
  return {
    encryptInstanceToken: real.encryptInstanceToken, decryptInstanceToken: real.decryptInstanceToken,
    uazapiCreateInstance: m.create, uazapiSetWebhook: m.setWebhook, uazapiConnect: m.connect, uazapiStatus: m.status,
    resetWhatsAppTargetCache: m.resetCache,
  };
});

import routes from "./uazapi.js";
import { decryptInstanceToken, encryptInstanceToken } from "@aula-agente/agent-runtime";

async function call(method: "GET" | "POST" | "PUT", url: string, payload?: object) {
  const app = Fastify(); await app.register(routes);
  const r = await app.inject({ method, url, payload }); await app.close(); return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.role.value = "admin";
  vi.stubEnv("UAZAPI_BASE_URL", "https://x.uazapi.com");
  vi.stubEnv("UAZAPI_ADMIN_TOKEN", "admin-1");
  vi.stubEnv("API_PUBLIC_URL", "https://api.exemplo/");
  vi.stubEnv("WEBHOOK_SECRET", "seg");
  m.instance = { id: "i1", organization_id: "org-1", instance_name: "weslley", instance_id: "weslley", provider: "evolution", provider_token_encrypted: null };
  m.create.mockResolvedValue({ token: "tok-novo" });
  m.connect.mockResolvedValue({ status: "connecting", qrcode: "data:image/png;base64,QR", paircode: null });
  m.status.mockResolvedValue({ status: "connected", qrcode: null, paircode: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("rotas UAZAPI da instância", () => {
  it("vendedor: 403 nas três rotas", async () => {
    m.role.value = "agent";
    expect((await call("POST", "/instances/i1/uazapi/connect", {})).statusCode).toBe(403);
    expect((await call("GET", "/instances/i1/uazapi/status")).statusCode).toBe(403);
    expect((await call("PUT", "/instances/i1/provider", { provider: "evolution" })).statusCode).toBe(403);
  });

  it("connect sem token: cria a instância, guarda o token cifrado, registra o webhook e devolve o QR", async () => {
    const r = await call("POST", "/instances/i1/uazapi/connect", {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "connecting", qrcode: "data:image/png;base64,QR", paircode: null });
    expect(m.create).toHaveBeenCalledWith("weslley");
    const stored = m.setFields.mock.calls[0][2].provider_token_encrypted as string;
    expect(stored).not.toBe("tok-novo");
    expect(decryptInstanceToken(stored)).toBe("tok-novo");
    expect(m.setWebhook).toHaveBeenCalledWith("tok-novo", "https://api.exemplo/webhooks/uazapi?apikey=seg");
    expect(m.connect).toHaveBeenCalledWith("tok-novo", undefined);
    expect(r.body).not.toContain("tok-novo");
  });

  it("connect com token guardado: não cria de novo; telefone vira código de pareamento", async () => {
    m.instance.provider_token_encrypted = encryptInstanceToken("tok-velho");
    await call("POST", "/instances/i1/uazapi/connect", { phone: "5562999990000" });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.connect).toHaveBeenCalledWith("tok-velho", "5562999990000");
  });

  it("telefone inválido: 400", async () => {
    expect((await call("POST", "/instances/i1/uazapi/connect", { phone: "12" })).statusCode).toBe(400);
  });

  it("connect sem API_PUBLIC_URL: 503 sem chamar a UAZAPI", async () => {
    vi.stubEnv("API_PUBLIC_URL", "");
    const r = await call("POST", "/instances/i1/uazapi/connect", {});
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "UAZAPI não configurada no servidor" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("status sem token: not_created", async () => {
    expect((await call("GET", "/instances/i1/uazapi/status")).json()).toEqual({ provider: "evolution", connected: false, status: "not_created", qrcode: null, paircode: null });
  });

  it("status com token: estado da UAZAPI", async () => {
    m.instance.provider_token_encrypted = encryptInstanceToken("tok");
    expect((await call("GET", "/instances/i1/uazapi/status")).json()).toEqual({ provider: "evolution", connected: true, status: "connected", qrcode: null, paircode: null });
  });

  it("virar para uazapi conectando: 409 e nada muda", async () => {
    m.instance.provider_token_encrypted = encryptInstanceToken("tok");
    m.status.mockResolvedValue({ status: "connecting", qrcode: "x", paircode: null });
    const r = await call("PUT", "/instances/i1/provider", { provider: "uazapi" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "UAZAPI não está conectada" });
    expect(m.setFields).not.toHaveBeenCalled();
  });

  it("virar para uazapi sem token: 409", async () => {
    expect((await call("PUT", "/instances/i1/provider", { provider: "uazapi" })).statusCode).toBe(409);
  });

  it("virar para uazapi conectada: grava e avisa o prazo do worker", async () => {
    m.instance.provider_token_encrypted = encryptInstanceToken("tok");
    const r = await call("PUT", "/instances/i1/provider", { provider: "uazapi" });
    expect(r.json()).toEqual({ ok: true, provider: "uazapi", effectiveWithinSeconds: 30 });
    expect(m.setFields).toHaveBeenCalledWith({}, "i1", { provider: "uazapi" });
    expect(m.resetCache).toHaveBeenCalled();
  });

  it("voltar para evolution: grava sem consultar a UAZAPI", async () => {
    m.instance.provider = "uazapi";
    const r = await call("PUT", "/instances/i1/provider", { provider: "evolution" });
    expect(r.json()).toMatchObject({ ok: true, provider: "evolution" });
    expect(m.status).not.toHaveBeenCalled();
  });

  it("provedor inválido: 400", async () => {
    expect((await call("PUT", "/instances/i1/provider", { provider: "zapi" })).statusCode).toBe(400);
  });
});
