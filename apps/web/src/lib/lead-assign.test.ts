import { describe, expect, it } from "vitest";
import { shouldUseManualAssign } from "./lead-assign";

describe("shouldUseManualAssign", () => {
  const base = { distributionOn: true, role: "owner" as string | null, targetRepId: "rep-1" as string | null };
  it("gestor passando a conversa a um vendedor com o rodízio ligado usa a reatribuição com histórico", () => {
    expect(shouldUseManualAssign(base)).toBe(true);
    expect(shouldUseManualAssign({ ...base, role: "admin" })).toBe(true);
  });
  it("vendedor, rodízio desligado ou destino que não é vendedor mantêm a troca simples", () => {
    expect(shouldUseManualAssign({ ...base, role: "agent" })).toBe(false);
    expect(shouldUseManualAssign({ ...base, role: null })).toBe(false);
    expect(shouldUseManualAssign({ ...base, distributionOn: false })).toBe(false);
    expect(shouldUseManualAssign({ ...base, targetRepId: null })).toBe(false);
  });
});
