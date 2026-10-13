import { describe, expect, it } from "vitest";
import { computeContactState, contactBadgeLabel } from "./contact-state.js";

describe("computeContactState", () => {
  it("sem nenhum contato", () => {
    expect(computeContactState({})).toEqual({ lastHumanMessageAt: null, lastCallAt: null, lastContactAt: null, contactedSinceAssigned: false });
  });
  it("usa o mais recente entre mensagem humana e ligação", () => {
    const s = computeContactState({ lastHumanMessageAt: "2026-10-10T10:00:00Z", lastCallAt: "2026-10-12T10:00:00Z" });
    expect(s.lastContactAt).toBe("2026-10-12T10:00:00Z");
  });
  it("contato anterior à chegada ao responsável não conta", () => {
    expect(computeContactState({ ownerAssignedAt: "2026-10-11T00:00:00Z", lastHumanMessageAt: "2026-10-10T10:00:00Z" }).contactedSinceAssigned).toBe(false);
    expect(computeContactState({ ownerAssignedAt: "2026-10-11T00:00:00Z", lastCallAt: "2026-10-12T10:00:00Z" }).contactedSinceAssigned).toBe(true);
  });
  it("sem data de atribuição, qualquer contato conta", () => {
    expect(computeContactState({ lastHumanMessageAt: "2026-01-01T00:00:00Z" }).contactedSinceAssigned).toBe(true);
  });
});

describe("contactBadgeLabel", () => {
  const now = "2026-10-13T15:00:00Z";
  it("sem contato", () => expect(contactBadgeLabel(null, now)).toEqual({ text: "Sem contato", tone: "none" }));
  it("hoje, ontem e dias", () => {
    const st = (iso: string) => computeContactState({ lastHumanMessageAt: iso });
    expect(contactBadgeLabel(st("2026-10-13T12:00:00Z"), now).text).toBe("Contatado hoje");
    expect(contactBadgeLabel(st("2026-10-12T12:00:00Z"), now).text).toBe("Último contato: ontem");
    expect(contactBadgeLabel(st("2026-10-09T12:00:00Z"), now)).toEqual({ text: "Último contato: há 4 dias", tone: "warn" });
  });
  it("contato antigo anterior à atribuição não fica verde", () => {
    const s = computeContactState({ ownerAssignedAt: "2026-10-13T00:00:00Z", lastHumanMessageAt: "2026-10-12T20:00:00Z" });
    expect(contactBadgeLabel(s, now).tone).toBe("none");
  });
});
