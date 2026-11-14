import { describe, expect, it, vi } from "vitest";
import {
  deliverViaConnectedInstance, describeInstanceStates, EvolutionRejectedError, fetchConnectionState, fetchInstanceOwners, findDuplicateOwners,
  NoConnectedInstanceError, normalizeConnectionState, parseInstanceOwners, rankSendInstances, sanitizeEvolutionError, type InstanceCandidate,
} from "./evolution-instances.js";

const c = (name: string, createdAt: string, liveState: InstanceCandidate["liveState"], activeAgent = true): InstanceCandidate => ({ name, createdAt, activeAgent, liveState });
// Incidente de 14/11/2026: "Pos venda" (mais nova, desconectada) era escolhida antes de "weslley" (principal, conectada).
const POS = c("Pos venda", "2026-11-09T17:40:36Z", "close"); const WES = c("weslley", "2026-07-20T14:34:10Z", "open");

describe("rankSendInstances", () => {
  it("o incidente: instância nova desconectada NÃO é escolhida; a conectada sim", () => {
    expect(rankSendInstances([POS, WES])).toEqual([{ name: "weslley", verified: true }]);
  });
  it("entre abertas: a preferida primeiro, depois a mais antiga (principal)", () => {
    const a = c("a", "2026-08-01T00:00:00Z", "open"); const b = c("b", "2026-07-01T00:00:00Z", "open");
    expect(rankSendInstances([a, b]).map((x) => x.name)).toEqual(["b", "a"]);
    expect(rankSendInstances([a, b], { preferred: "a" }).map((x) => x.name)).toEqual(["a", "b"]);
  });
  it("preferida desconectada não passa na frente: só abertas entram", () => {
    expect(rankSendInstances([POS, WES], { preferred: "Pos venda" }).map((x) => x.name)).toEqual(["weslley"]);
  });
  it("sem agente ativo, conectando ou fechada: nunca", () => {
    expect(rankSendInstances([c("x", "2026-01-01T00:00:00Z", "open", false), c("y", "2026-01-01T00:00:00Z", "connecting"), POS])).toEqual([]);
  });
  it("Evolution inalcançável (todas unknown): tenta as desconhecidas como último recurso, marcadas não verificadas", () => {
    expect(rankSendInstances([c("a", "2026-08-01T00:00:00Z", "unknown"), c("b", "2026-07-01T00:00:00Z", "unknown")])).toEqual([{ name: "b", verified: false }, { name: "a", verified: false }]);
  });
  it("uma aberta + uma desconhecida: só a aberta (a desconhecida não rouba a vez)", () => {
    expect(rankSendInstances([c("a", "2026-01-01T00:00:00Z", "unknown"), WES])).toEqual([{ name: "weslley", verified: true }]);
  });
  it("describeInstanceStates não traz número nem chave", () => { expect(describeInstanceStates([POS, WES])).toBe("Pos venda=close, weslley=open"); });
});

describe("normalizeConnectionState", () => {
  it.each([[{ instance: { state: "open" } }, "open"], [{ state: "close" }, "close"], [{ instance: { state: "connecting" } }, "connecting"], [{ instance: {} }, "unknown"], [null, "unknown"], ["x", "unknown"], [{ state: 3 }, "unknown"]])("%j", (raw, exp) => {
    expect(normalizeConnectionState(raw)).toBe(exp);
  });
});

describe("pareamento duplicado", () => {
  it("duas instâncias com o mesmo número (como no Evolution Manager em 14/11)", () => {
    const owners = parseInstanceOwners([{ name: "Pos venda", ownerJid: "556296799050@s.whatsapp.net" }, { instance: { instanceName: "weslley", owner: "556296799050@s.whatsapp.net" } }, { name: "outra", number: "5511999990000" }]);
    expect(owners).toEqual([{ name: "Pos venda", ownerNumber: "556296799050" }, { name: "weslley", ownerNumber: "556296799050" }, { name: "outra", ownerNumber: "5511999990000" }]);
    expect(findDuplicateOwners(owners)).toEqual([["Pos venda", "weslley"]]);
  });
  it("sem número ou curto demais não conta; formato inesperado não quebra", () => {
    expect(findDuplicateOwners([{ name: "a", ownerNumber: null }, { name: "b", ownerNumber: "123" }, { name: "c", ownerNumber: "123" }])).toEqual([]);
    expect(parseInstanceOwners({ nope: 1 })).toEqual([]);
  });
});

describe("sanitizeEvolutionError", () => {
  it("mantém status e mensagem útil", () => {
    expect(sanitizeEvolutionError(400, JSON.stringify({ status: 400, error: "Bad Request", response: { message: ["Connection Closed"] } }))).toBe('Evolution API send error 400: ["Connection Closed"]');
  });
  it("remove chave, URL e telefone", () => {
    const out = sanitizeEvolutionError(500, 'apikey: ABCDEF123 falhou em https://evo.example.com/x?token=1 para 5562996188374 {"authorization":"Bearer zzz"}');
    expect(out).not.toMatch(/ABCDEF123|evo\.example|5562996188374|zzz/);
    expect(out).toContain("[redacted]"); expect(out).toContain("[url]"); expect(out).toContain("***");
  });
  it("trunca e aceita corpo vazio", () => {
    expect(sanitizeEvolutionError(502, "x".repeat(900)).length).toBeLessThan(260);
    expect(sanitizeEvolutionError(500, "")).toBe("Evolution API send error 500");
  });
});

describe("deliverViaConnectedInstance", () => {
  it("envia pela primeira conectada", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await deliverViaConnectedInstance([{ name: "weslley", verified: true }], send)).toBe("weslley");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("recusa explícita (400) tenta a próxima; sucesso devolve a que enviou", async () => {
    const send = vi.fn().mockRejectedValueOnce(new EvolutionRejectedError(400, "Evolution API send error 400: Connection Closed")).mockResolvedValueOnce(undefined);
    expect(await deliverViaConnectedInstance([{ name: "a", verified: true }, { name: "b", verified: true }], send)).toBe("b");
  });
  it("erro ambíguo (timeout) PARA: nunca tenta a próxima e não duplica o aviso", async () => {
    const send = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(deliverViaConnectedInstance([{ name: "a", verified: true }, { name: "b", verified: true }], send)).rejects.toThrow("timeout");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("sem instância: erro claro com os estados; todas recusam: erro agregado sem segredos", async () => {
    await expect(deliverViaConnectedInstance([], vi.fn(), "Pos venda=close")).rejects.toBeInstanceOf(NoConnectedInstanceError);
    const send = vi.fn().mockRejectedValue(new EvolutionRejectedError(400, "Evolution API send error 400: x"));
    const err = await deliverViaConnectedInstance([{ name: "a", verified: true }, { name: "b", verified: true }], send).catch((e) => e);
    expect(err).toBeInstanceOf(NoConnectedInstanceError); expect(err.attempts).toHaveLength(2);
  });
});

describe("consultas à Evolution", () => {
  it("fetchConnectionState: lê o estado, e qualquer falha vira unknown sem lançar", async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ instance: { state: "open" } }) });
    expect(await fetchConnectionState({ baseUrl: "http://evo", apiKey: "k", instanceName: "Pos venda", fetchImpl: ok as never })).toBe("open");
    expect(ok.mock.calls[0][0]).toBe("http://evo/instance/connectionState/Pos%20venda");
    expect(await fetchConnectionState({ baseUrl: "h", apiKey: "k", instanceName: "x", fetchImpl: vi.fn().mockRejectedValue(new Error("down")) as never })).toBe("unknown");
    expect(await fetchConnectionState({ baseUrl: "h", apiKey: "k", instanceName: "x", fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 404 }) as never })).toBe("unknown");
    expect(await fetchConnectionState({ baseUrl: "h", apiKey: "k", instanceName: "x", fetchImpl: vi.fn().mockResolvedValue({ ok: true }) as never })).toBe("unknown");
  });
  it("fetchInstanceOwners: nunca lança", async () => {
    expect(await fetchInstanceOwners({ baseUrl: "h", apiKey: "k", fetchImpl: vi.fn().mockRejectedValue(new Error("x")) as never })).toEqual([]);
  });
});
