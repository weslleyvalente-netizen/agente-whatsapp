import { describe, expect, it } from "vitest";
import { parseConnectionState, parseDisconnection, newestReceivedTimestamp, classifyObserveError, ObserveInvalidResponseError, observeDisconnection, observeLatestReceivedAt } from "./evolution.service.js";
import { afterEach, vi } from "vitest";

describe("parseConnectionState", () => {
  it("lê instance.state e state", () => {
    expect(parseConnectionState({ instance: { instanceName: "weslley", state: "open" } })).toBe("open");
    expect(parseConnectionState({ state: "close" })).toBe("close");
  });
  it("devolve null para resposta inesperada", () => {
    expect(parseConnectionState(null)).toBeNull();
    expect(parseConnectionState({})).toBeNull();
    expect(parseConnectionState({ instance: { state: 5 } })).toBeNull();
  });
});

describe("parseDisconnection", () => {
  it("acha a instância pelo nome numa lista", () => {
    const res = [
      { name: "outra", disconnectionAt: "2026-01-01T00:00:00.000Z", disconnectionReasonCode: 515 },
      { name: "weslley", disconnectionAt: "2026-11-12T14:16:27.094Z", disconnectionReasonCode: 401 },
    ];
    expect(parseDisconnection(res, "weslley")).toEqual({ at: new Date("2026-11-12T14:16:27.094Z"), reasonCode: 401 });
  });
  it("aceita objeto único e instance.instanceName", () => {
    expect(parseDisconnection({ name: "weslley", disconnectionAt: "2026-11-12T14:16:27.094Z", disconnectionReasonCode: "428" }, "weslley")).toEqual({ at: new Date("2026-11-12T14:16:27.094Z"), reasonCode: 428 });
    expect(parseDisconnection([{ instance: { instanceName: "weslley" }, disconnectionAt: "2026-11-12T14:16:27.094Z" }], "weslley")!.at).toEqual(new Date("2026-11-12T14:16:27.094Z"));
  });
  it("instância presente sem desconexão registrada: nulos (ausência de evento)", () => {
    expect(parseDisconnection([{ name: "weslley", disconnectionAt: null, disconnectionReasonCode: null }], "weslley")).toEqual({ at: null, reasonCode: null });
  });
  it("instância ausente ou resposta inválida: null (não é o mesmo que ausência de evento)", () => {
    expect(parseDisconnection([{ name: "x" }], "weslley")).toBeNull();
    expect(parseDisconnection("lixo", "weslley")).toBeNull();
    expect(parseDisconnection(null, "weslley")).toBeNull();
    expect(parseDisconnection([], "weslley")).toBeNull();
  });
  it("data inválida ou código não numérico é resposta inválida (null), não 'sem desconexão'", () => {
    expect(parseDisconnection({ name: "weslley", disconnectionAt: "ontem", disconnectionReasonCode: 401 }, "weslley")).toBeNull();
    expect(parseDisconnection({ name: "weslley", disconnectionAt: "2026-11-12T14:16:27.094Z", disconnectionReasonCode: "abc" }, "weslley")).toBeNull();
    expect(parseDisconnection({ name: "weslley", disconnectionAt: 12345, disconnectionReasonCode: null }, "weslley")).toBeNull();
  });
  it("data ausente (null/undefined) com código ausente continua sendo 'sem desconexão registrada'", () => {
    expect(parseDisconnection({ name: "weslley", disconnectionAt: undefined }, "weslley")).toEqual({ at: null, reasonCode: null });
  });
  it("fuso: resposta REAL e sanitizada da 2.3.7 (12/11/2026, 4 campos): ISO em UTC com 'Z'; o instante lido é o mesmo", () => {
    // Capturada do próprio Evolution (GET /instance/fetchInstances?instanceName=weslley, só estes campos). 22:28:00Z = 19:28 em Brasília,
    // que foi quando o QR foi relido; a coluna é Timestamp (sem fuso) e a API a serializa em UTC com "Z".
    const real = { name: "weslley", connectionStatus: "open", disconnectionReasonCode: 401, disconnectionAt: "2026-11-12T22:28:00.859Z" };
    const out = parseDisconnection([real], "weslley")!;
    expect(out).toEqual({ at: new Date(Date.UTC(2026, 10, 12, 22, 28, 0, 859)), reasonCode: 401 });
    expect(out.at!.toISOString()).toBe("2026-11-12T22:28:00.859Z");
  });
  it("não devolve nenhum outro campo (disconnectionObject pode ter dados de sessão)", () => {
    const out = parseDisconnection({ name: "weslley", disconnectionAt: "2026-11-12T14:16:27.094Z", disconnectionReasonCode: 401, disconnectionObject: "{secret}", token: "abc" }, "weslley")!;
    expect(Object.keys(out).sort()).toEqual(["at", "reasonCode"]);
  });
});

describe("newestReceivedTimestamp", () => {
  it("pega o maior messageTimestamp, em segundos (número ou texto)", () => {
    const recs = [{ messageTimestamp: 1000 }, { messageTimestamp: "1800000000" }, { messageTimestamp: 1500 }] as never[];
    expect(newestReceivedTimestamp(recs)).toEqual(new Date(1800000000 * 1000));
  });
  it("lista vazia ou sem horário válido: null", () => {
    expect(newestReceivedTimestamp([])).toBeNull();
    expect(newestReceivedTimestamp([{ messageTimestamp: "x" }] as never[])).toBeNull();
  });
});

describe("classifyObserveError", () => {
  it("classifica sem vazar texto do erro", () => {
    expect(classifyObserveError(new Error("Evolution API error 401: {\"apikey\":\"abc\"}"))).toBe("http_401");
    expect(classifyObserveError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyObserveError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
    expect(classifyObserveError(new TypeError("fetch failed http://evolution/secret"))).toBe("network");
    expect(classifyObserveError("qualquer coisa")).toBe("unknown");
    expect(classifyObserveError(new ObserveInvalidResponseError())).toBe("invalid_response");
  });
});

describe("consultas reais com fetch simulado", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
  const respond = (...bodies: unknown[]) => {
    const f = vi.fn();
    for (const b of bodies) f.mockResolvedValueOnce({ ok: true, json: async () => b, text: async () => "" });
    globalThis.fetch = f as never;
    return f;
  };

  it("observeDisconnection: instância ausente na resposta vira invalid_response", async () => {
    respond([{ name: "outra" }]);
    await expect(observeDisconnection("weslley")).rejects.toBeInstanceOf(ObserveInvalidResponseError);
  });

  it("observeDisconnection: data inválida vira invalid_response", async () => {
    respond([{ name: "weslley", disconnectionAt: "ontem", disconnectionReasonCode: 401 }]);
    await expect(observeDisconnection("weslley")).rejects.toBeInstanceOf(ObserveInvalidResponseError);
  });

  it("observeLatestReceivedAt: lista vazia é 'sem mensagens' (null), não erro", async () => {
    respond({ messages: { total: 0, pages: 0, records: [] } });
    expect(await observeLatestReceivedAt("weslley")).toBeNull();
  });

  it("observeLatestReceivedAt: resposta sem lista de mensagens é invalid_response", async () => {
    respond({ qualquer: "coisa" });
    await expect(observeLatestReceivedAt("weslley")).rejects.toBeInstanceOf(ObserveInvalidResponseError);
  });

  it("observeLatestReceivedAt: na 2.3.7 o filtro fromMe=false é ignorado; filtra no cliente e ignora as enviadas", async () => {
    const f = respond({ messages: { total: 3, pages: 1, records: [
      { key: { fromMe: true }, messageTimestamp: 9000 },   // enviada mais nova: não conta
      { key: { fromMe: false }, messageTimestamp: 8000 },
      { key: { fromMe: false }, messageTimestamp: 7000 },
    ] } });
    expect(await observeLatestReceivedAt("weslley")).toEqual(new Date(8000 * 1000));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body).toMatchObject({ page: 1, offset: 50 });
    expect(JSON.stringify(body.where ?? {})).not.toContain("fromMe"); // filtro enganoso removido
  });

  it("observeLatestReceivedAt: se a 1ª página só tem enviadas, procura nas seguintes (ordem decrescente da 2.3.7), até um teto", async () => {
    const out = [{ key: { fromMe: true }, messageTimestamp: 9000 }];
    const f = respond(
      { messages: { total: 400, pages: 8, records: out } },
      { messages: { total: 400, pages: 8, records: out } },
      { messages: { total: 400, pages: 8, records: [{ key: { fromMe: false }, messageTimestamp: 6000 }] } },
    );
    expect(await observeLatestReceivedAt("weslley")).toEqual(new Date(6000 * 1000));
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("observeLatestReceivedAt: sem nenhuma recebida nas páginas do teto devolve null sem passar do limite", async () => {
    const only = { messages: { total: 1000, pages: 20, records: [{ key: { fromMe: true }, messageTimestamp: 9000 }] } };
    const f = respond(only, only, only, only, only, only);
    expect(await observeLatestReceivedAt("weslley")).toBeNull();
    expect(f.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("observeLatestReceivedAt: uma página só faz uma consulta", async () => {
    const f = respond({ messages: { pages: 1, records: [{ key: { fromMe: false }, messageTimestamp: 2000 }] } });
    expect(await observeLatestReceivedAt("weslley")).toEqual(new Date(2000 * 1000));
    expect(f).toHaveBeenCalledTimes(1);
  });
});
