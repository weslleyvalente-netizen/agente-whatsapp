import { describe, expect, it } from "vitest";
import { funnelConversationHref, parseFunnelConversationParam, pickFunnelOpportunity } from "./funnel-link.js";

const ID = "3f2b8c1e-5d4a-4e9b-8a7c-1234567890ab";
describe("funnelConversationHref", () => {
  it("aponta para o funil com a conversa", () => expect(funnelConversationHref(ID)).toBe(`/opportunities?conversa=${ID}`));
  it("escapa caracteres especiais", () => expect(funnelConversationHref("a&b")).toBe("/opportunities?conversa=a%26b"));
});
describe("parseFunnelConversationParam", () => {
  it("aceita UUID", () => expect(parseFunnelConversationParam(` ${ID} `)).toBe(ID));
  it.each([null, undefined, "", "abc", "../inbox", `${ID}x`])("ignora %s", (v) => expect(parseFunnelConversationParam(v as any)).toBeNull());
});
describe("pickFunnelOpportunity", () => {
  const o = (id: string, ownerId: string | null, lastInteractionAt: string | null) => ({ id, ownerId, lastInteractionAt });
  it("lista vazia", () => expect(pickFunnelOpportunity([])).toBeNull());
  it("prefere com dono", () => expect(pickFunnelOpportunity([o("a", null, "2026-02-01"), o("b", "u", "2026-01-01")])!.id).toBe("b"));
  it("entre os com dono, a interação mais recente", () => expect(pickFunnelOpportunity([o("a", "u", "2026-01-01"), o("b", "u", "2026-02-01")])!.id).toBe("b"));
  it("desempata por id", () => expect(pickFunnelOpportunity([o("b", "u", null), o("a", "u", null)])!.id).toBe("a"));
});
