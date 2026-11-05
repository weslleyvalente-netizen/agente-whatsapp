import { describe, expect, it } from "vitest";
import { canSuggestMessage, initialSuggestionMode, suggestionErrorMessage } from "./message-suggestion";

const ok = { enabled: true, status: "open", detailsLoaded: true, hasConversation: true };
describe("canSuggestMessage", () => {
  it("liga só com tudo presente", () => expect(canSuggestMessage(ok)).toBe(true));
  it.each([{ enabled: false }, { status: "won" }, { detailsLoaded: false }, { hasConversation: false }])("desliga com %o", patch => expect(canSuggestMessage({ ...ok, ...patch })).toBe(false));
});
describe("initialSuggestionMode", () => {
  it("sem mensagem de humano: primeiro atendimento", () => expect(initialSuggestionMode({ contact_state: { lastHumanMessageAt: null }, sales_state: { handedAt: "2026-10-01T10:00:00Z" } })).toBe("first_contact"));
  it("humano falou antes do encaminhamento/atribuição: primeiro atendimento", () => expect(initialSuggestionMode({ contact_state: { lastHumanMessageAt: "2026-10-01T09:00:00Z" }, owner_assigned_at: "2026-10-01T10:00:00Z" })).toBe("first_contact"));
  it("humano falou depois: follow-up", () => expect(initialSuggestionMode({ contact_state: { lastHumanMessageAt: "2026-10-01T11:00:00Z" }, owner_assigned_at: "2026-10-01T10:00:00Z", sales_state: { handedAt: "2026-10-01T09:30:00Z" } })).toBe("followup"));
  it("sem nada no card: primeiro atendimento", () => expect(initialSuggestionMode({})).toBe("first_contact"));
});
describe("suggestionErrorMessage", () => {
  it("429 explica o limite", () => expect(suggestionErrorMessage({ status: 429, message: "x" })).toContain("limite"));
  it("falha do gerador usa o texto padrão", () => expect(suggestionErrorMessage({ status: 503, message: "Não foi possível gerar. Tente de novo." })).toBe("Não foi possível gerar. Tente de novo."));
  it("422 mostra o motivo da API", () => expect(suggestionErrorMessage({ status: 422, message: "Há áudio sem transcrição" })).toBe("Há áudio sem transcrição"));
});
