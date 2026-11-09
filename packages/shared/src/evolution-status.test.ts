import { describe, it, expect } from "vitest";
import { isEvolutionStatusEvent, parseEvolutionStatusUpdate } from "./evolution-status.js";

const base = { event: "messages.update", instance: "weslley" };

describe("parseEvolutionStatusUpdate", () => {
  it("DELIVERY_ACK vira entregue, usando keyId", () => {
    expect(parseEvolutionStatusUpdate({ ...base, data: { keyId: "ABC", messageId: "internal", status: "DELIVERY_ACK", fromMe: true } }))
      .toEqual({ instance: "weslley", messageId: "ABC", status: "delivered" });
  });
  it("READ e PLAYED viram lida", () => {
    expect(parseEvolutionStatusUpdate({ ...base, data: { keyId: "A", status: "READ" } })?.status).toBe("read");
    expect(parseEvolutionStatusUpdate({ ...base, data: { keyId: "A", status: "PLAYED" } })?.status).toBe("read");
  });
  it("aceita o evento em MAIÚSCULAS com _ e data em lista, id em key.id", () => {
    expect(parseEvolutionStatusUpdate({ event: "MESSAGES_UPDATE", instance: "i", data: [{ key: { id: "K" }, status: "read" }] }))
      .toEqual({ instance: "i", messageId: "K", status: "read" });
  });
  it("ignora SERVER_ACK, status desconhecido e mensagem do cliente", () => {
    expect(parseEvolutionStatusUpdate({ ...base, data: { keyId: "A", status: "SERVER_ACK" } })).toBeNull();
    expect(parseEvolutionStatusUpdate({ ...base, data: { keyId: "A", status: "???" } })).toBeNull();
    expect(parseEvolutionStatusUpdate({ ...base, data: { keyId: "A", status: "READ", fromMe: false } })).toBeNull();
  });
  it("formato inesperado vira null sem lançar", () => {
    for (const b of [null, undefined, 5, "x", {}, { ...base }, { ...base, data: null }, { ...base, data: { status: "READ" } }, { event: "messages.upsert", instance: "i", data: { keyId: "A", status: "READ" } }, { event: "messages.update", data: { keyId: "A", status: "READ" } }]) {
      expect(parseEvolutionStatusUpdate(b)).toBeNull();
    }
  });
  it("isEvolutionStatusEvent reconhece só messages.update", () => {
    expect(isEvolutionStatusEvent({ event: "messages.update" })).toBe(true);
    expect(isEvolutionStatusEvent({ event: "messages.upsert" })).toBe(false);
  });
});
