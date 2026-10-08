import { describe, expect, it } from "vitest";
import { isLeadVisible, isSellerFilterEnabled, resolveLeadVisibility } from "./lead-visibility.js";

describe("resolveLeadVisibility", () => {
  it("gestor (owner/admin) vê tudo", () => {
    for (const role of ["owner", "admin"]) expect(resolveLeadVisibility({ role, userId: "u", leadDistributionEnabled: true })).toEqual({ mode: "all" });
  });
  it("com a flag desligada ninguém é restringido (comportamento atual)", () => {
    expect(resolveLeadVisibility({ role: "agent", userId: "u", leadDistributionEnabled: false })).toEqual({ mode: "all" });
  });
  it("vendedor com a flag ligada vê os próprios", () => {
    expect(resolveLeadVisibility({ role: "agent", userId: "u", leadDistributionEnabled: true })).toEqual({ mode: "own", userId: "u" });
  });
});

describe("isLeadVisible", () => {
  const reps = new Set(["marina", "marcio"]);
  it("modo all vê tudo", () => { expect(isLeadVisible({ mode: "all" }, "marcio", reps)).toBe(true); });
  it("vendedor vê os próprios", () => { expect(isLeadVisible({ mode: "own", userId: "marina" }, "marina", reps)).toBe(true); });
  it("vendedor NÃO vê o lead de outro vendedor", () => { expect(isLeadVisible({ mode: "own", userId: "marina" }, "marcio", reps)).toBe(false); });
  it("legado sem dono ou com dono que não é vendedor continua visível (decisão de planejamento 1)", () => {
    expect(isLeadVisible({ mode: "own", userId: "marina" }, null, reps)).toBe(true);
    expect(isLeadVisible({ mode: "own", userId: "marina" }, "conta-compartilhada", reps)).toBe(true);
  });
});

describe("isSellerFilterEnabled", () => {
  it("vale com distribuição OU isolamento ligados", () => {
    expect(isSellerFilterEnabled({ lead_distribution_enabled: true })).toBe(true);
    expect(isSellerFilterEnabled({ seller_isolation_enabled: true })).toBe(true);
    expect(isSellerFilterEnabled({})).toBe(false);
    expect(isSellerFilterEnabled(undefined)).toBe(false);
  });
});
