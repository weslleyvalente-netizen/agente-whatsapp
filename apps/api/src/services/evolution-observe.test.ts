import { describe, expect, it } from "vitest";
import { parseConnectionState, parseDisconnection, newestReceivedTimestamp, classifyObserveError } from "./evolution.service.js";

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
    expect(parseDisconnection([{ instance: { instanceName: "weslley" }, disconnectionAt: "2026-11-12T14:16:27.094Z" }], "weslley").at).toEqual(new Date("2026-11-12T14:16:27.094Z"));
  });
  it("sem registro de desconexão ou instância ausente: nulos", () => {
    expect(parseDisconnection([{ name: "weslley", disconnectionAt: null, disconnectionReasonCode: null }], "weslley")).toEqual({ at: null, reasonCode: null });
    expect(parseDisconnection([{ name: "x" }], "weslley")).toEqual({ at: null, reasonCode: null });
    expect(parseDisconnection("lixo", "weslley")).toEqual({ at: null, reasonCode: null });
  });
  it("data inválida vira null, e o código não numérico também", () => {
    expect(parseDisconnection({ name: "weslley", disconnectionAt: "ontem", disconnectionReasonCode: "abc" }, "weslley")).toEqual({ at: null, reasonCode: null });
  });
  it("não devolve nenhum outro campo (disconnectionObject pode ter dados de sessão)", () => {
    const out = parseDisconnection({ name: "weslley", disconnectionAt: "2026-11-12T14:16:27.094Z", disconnectionReasonCode: 401, disconnectionObject: "{secret}", token: "abc" }, "weslley");
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
  });
});
