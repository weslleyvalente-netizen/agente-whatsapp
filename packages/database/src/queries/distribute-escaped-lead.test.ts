import { describe, expect, it, vi } from "vitest";
const o = vi.hoisted(() => ({ getOrganizationById: vi.fn() }));
vi.mock("./organizations.js", () => o);
import { distributeEscapedLead } from "./lead-distribution.js";

const db = (rpc: (...a: any[]) => any) => ({ rpc: vi.fn(rpc), from: vi.fn(() => { throw new Error("não pode escrever fora da função atômica"); }) }) as any;

describe("distributeEscapedLead (TypeScript)", () => {
  it("só chama a função atômica, com o prazo de SLA; nunca grava takeover/encaminhamento por conta própria", async () => {
    o.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true, lead_sla_minutes: 30 } });
    const d = db(async () => ({ data: "assign-1", error: null }));
    expect(await distributeEscapedLead(d, "org", "conv", new Date("2026-11-23T13:00:00Z"))).toBe("assign-1");
    expect(d.rpc).toHaveBeenCalledWith("distribute_escaped_lead", { p_organization_id: "org", p_conversation_id: "conv", p_sla_due_at: "2026-11-23T13:30:00.000Z" });
    expect(d.from).not.toHaveBeenCalled();
  });
  it("rodízio vazio devolve null; erro lança (a varredura libera a chave e tenta de novo)", async () => {
    o.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } });
    expect(await distributeEscapedLead(db(async () => ({ data: null, error: null })), "org", "conv")).toBeNull();
    await expect(distributeEscapedLead(db(async () => ({ data: null, error: new Error("rpc") })), "org", "conv")).rejects.toThrow("rpc");
  });
  it("distribuição desligada: não chama nada", async () => {
    o.getOrganizationById.mockResolvedValue({ settings: {} });
    const d = db(async () => ({ data: "x", error: null }));
    expect(await distributeEscapedLead(d, "org", "conv")).toBeNull();
    expect(d.rpc).not.toHaveBeenCalled();
  });
});
