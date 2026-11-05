import { describe, expect, it } from "vitest";
import { defaultSuggestionMode, isUntranscribedMedia, latestInstant, messageSuggestionBodySchema, suggestionRoleLabel } from "./seller-message-suggestion.js";

describe("defaultSuggestionMode", () => {
  it("sem mensagem de humano é primeiro atendimento", () => expect(defaultSuggestionMode({ lastHumanMessageAt: null, since: "2026-10-01T10:00:00Z" })).toBe("first_contact"));
  it("mensagem de humano anterior ao encaminhamento ainda é primeiro atendimento", () => expect(defaultSuggestionMode({ lastHumanMessageAt: "2026-10-01T09:00:00Z", since: "2026-10-01T10:00:00Z" })).toBe("first_contact"));
  it("mensagem de humano depois do encaminhamento é follow-up", () => expect(defaultSuggestionMode({ lastHumanMessageAt: "2026-10-01T11:00:00Z", since: "2026-10-01T10:00:00Z" })).toBe("followup"));
  it("sem data de encaminhamento, qualquer mensagem de humano é follow-up", () => expect(defaultSuggestionMode({ lastHumanMessageAt: "2026-10-01T11:00:00Z" })).toBe("followup"));
  it("data inválida não vira follow-up", () => expect(defaultSuggestionMode({ lastHumanMessageAt: "x" })).toBe("first_contact"));
});
describe("auxiliares", () => {
  it("latestInstant ignora vazios e inválidos", () => {
    expect(latestInstant(null, "2026-10-01T10:00:00Z", "lixo", "2026-10-02T10:00:00Z")).toBe("2026-10-02T10:00:00Z");
    expect(latestInstant(null, undefined)).toBeNull();
  });
  it("mapeia papéis", () => {
    expect(suggestionRoleLabel("contact")).toBe("cliente");
    expect(suggestionRoleLabel("human_agent")).toBe("vendedora");
    expect(suggestionRoleLabel("agent")).toBe("IA");
  });
  it("reconhece mídia sem conteúdo", () => {
    expect(isUntranscribedMedia("[audio]")).toBe(true);
    expect(isUntranscribedMedia("🎤 quero uma Factor")).toBe(false);
  });
  it("valida o corpo", () => {
    expect(messageSuggestionBodySchema.safeParse({}).success).toBe(true);
    expect(messageSuggestionBodySchema.safeParse({ mode: "outro" }).success).toBe(false);
  });
});
