import { describe, it, expect } from "vitest";
import { effectiveMessageTimestampSec } from "./stale-guard.js";

describe("effectiveMessageTimestampSec", () => {
  const created = "2026-11-18T18:00:00.000Z";
  it("usa o instante original do WhatsApp quando existe", () => {
    expect(effectiveMessageTimestampSec({ created_at: created, metadata: { wa_original_at: "2026-11-18T15:30:00.000Z" } })).toBe(Date.parse("2026-11-18T15:30:00Z") / 1000);
  });
  it("sem original: usa a hora de gravação (cobre fila atrasada, retry e varredor)", () => {
    expect(effectiveMessageTimestampSec({ created_at: created, metadata: null })).toBe(Date.parse(created) / 1000);
    expect(effectiveMessageTimestampSec({ created_at: created })).toBe(Date.parse(created) / 1000);
    expect(effectiveMessageTimestampSec({ created_at: created, metadata: { wa_original_at: 123 } })).toBe(Date.parse(created) / 1000);
    expect(effectiveMessageTimestampSec({ created_at: created, metadata: { wa_original_at: "lixo" } })).toBe(Date.parse(created) / 1000);
  });
  it("original depois da chegada (relógio errado) é ignorado; pequena folga é aceita", () => {
    expect(effectiveMessageTimestampSec({ created_at: created, metadata: { wa_original_at: "2026-11-18T19:00:00.000Z" } })).toBe(Date.parse(created) / 1000);
    expect(effectiveMessageTimestampSec({ created_at: created, metadata: { wa_original_at: "2026-11-18T18:02:00.000Z" } })).toBe(Date.parse("2026-11-18T18:02:00Z") / 1000);
  });
  it("sem nenhum instante válido: undefined (a proteção segue como hoje)", () => {
    expect(effectiveMessageTimestampSec({ created_at: "nope", metadata: null })).toBeUndefined();
  });
});
