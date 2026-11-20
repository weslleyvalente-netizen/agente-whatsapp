import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getInstanceByInstanceName: vi.fn() }));
vi.mock("@aula-agente/database", () => ({ getAdminClient: () => ({}), getInstanceByInstanceName: m.getInstanceByInstanceName }));

import { resetWhatsAppTargetCache, resolveWhatsAppTarget, targetFromInstance } from "./target.js";
import { encryptInstanceToken } from "./instance-token.js";

beforeEach(() => {
  vi.stubEnv("UAZAPI_ADMIN_TOKEN", "admin-1");
  vi.stubEnv("UAZAPI_BASE_URL", "https://x.uazapi.com");
  resetWhatsAppTargetCache();
  m.getInstanceByInstanceName.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("targetFromInstance", () => {
  it("sem provider = evolution", () => {
    expect(targetFromInstance({ instance_name: "w" })).toEqual({ provider: "evolution", instanceName: "w" });
  });
  it("uazapi com token cifrado devolve o token decifrado", () => {
    expect(targetFromInstance({ instance_name: "w", provider: "uazapi", provider_token_encrypted: encryptInstanceToken("tok") }))
      .toEqual({ provider: "uazapi", instanceName: "w", token: "tok" });
  });
  it("uazapi sem token: erro claro", () => {
    expect(() => targetFromInstance({ instance_name: "w", provider: "uazapi", provider_token_encrypted: null }))
      .toThrow("instância em UAZAPI sem token: conecte a UAZAPI antes de virar");
  });
});

describe("resolveWhatsAppTarget", () => {
  it("usa cache de 30 s por nome e consulta de novo após reset", async () => {
    m.getInstanceByInstanceName.mockResolvedValue({ instance_name: "w", provider: "evolution" });
    await resolveWhatsAppTarget("w");
    await resolveWhatsAppTarget("w");
    expect(m.getInstanceByInstanceName).toHaveBeenCalledTimes(1);
    resetWhatsAppTargetCache();
    await resolveWhatsAppTarget("w");
    expect(m.getInstanceByInstanceName).toHaveBeenCalledTimes(2);
  });
  it("instância não encontrada = evolution", async () => {
    m.getInstanceByInstanceName.mockResolvedValue(null);
    expect(await resolveWhatsAppTarget("x")).toEqual({ provider: "evolution", instanceName: "x" });
  });
  it("sem UAZAPI_BASE_URL nem consulta o banco (comportamento de sempre)", async () => {
    vi.stubEnv("UAZAPI_BASE_URL", "");
    expect(await resolveWhatsAppTarget("w")).toEqual({ provider: "evolution", instanceName: "w" });
    expect(m.getInstanceByInstanceName).not.toHaveBeenCalled();
  });
});
