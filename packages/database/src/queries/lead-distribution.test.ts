// packages/database/src/queries/lead-distribution.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  acceptAssignment, computeSlaDueAt, distributeLeadForHandoff, recordHumanMessage, redistributeAssignment,
} from "./lead-distribution.js";

vi.mock("./organizations.js", () => ({ getOrganizationById: vi.fn() }));
import { getOrganizationById } from "./organizations.js";

const rpcDb = (data: unknown = "id-1", error: unknown = null) => {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { db: { rpc } as any, rpc };
};

describe("computeSlaDueAt", () => {
  it("usa 15 minutos úteis por padrão e pula o fim de semana", () => {
    const due = computeSlaDueAt({}, new Date("2026-10-09T20:50:00Z")); // sex 17:50
    expect(due.toISOString()).toBe("2026-10-12T11:05:00.000Z");
  });
  it("respeita lead_sla_minutes e business_calendar configurados", () => {
    const due = computeSlaDueAt({ lead_sla_minutes: 30, business_calendar: { weekly: { sat: [{ start: "08:00", end: "12:00" }] } } as any }, new Date("2026-10-10T14:00:00Z"));
    expect(due.toISOString()).toBe("2026-10-10T14:30:00.000Z"); // sáb 11:00 + 30 → 11:30 (janela de sábado configurada)
  });
  it("calendário inválido nunca derruba: usa o padrão", () => {
    const due = computeSlaDueAt({ business_calendar: { weekly: {} } as any }, new Date("2026-10-05T12:00:00Z"));
    expect(due.toISOString()).toBe("2026-10-05T12:15:00.000Z");
  });
});

describe("distributeLeadForHandoff", () => {
  it("modo sombra: chama distribute_lead_shadow quando só a sombra está ligada", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_shadow_enabled: true } } as any);
    const { db, rpc } = rpcDb("shadow-1");
    const id = await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h", now: new Date("2026-10-05T12:00:00Z") });
    expect(id).toBe("shadow-1");
    expect(rpc).toHaveBeenCalledWith("distribute_lead_shadow", expect.objectContaining({ p_handoff_event_id: "h", p_sla_due_at: "2026-10-05T12:15:00.000Z" }));
  });
  it("com a real ligada, ignora a sombra", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_enabled: true, lead_distribution_shadow_enabled: true } } as any);
    const { db, rpc } = rpcDb("real-1");
    await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h" });
    expect(rpc).toHaveBeenCalledWith("distribute_lead", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("distribute_lead_shadow", expect.anything());
  });
  it("não chama o banco com tudo desligado", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: {} } as any);
    const { db, rpc } = rpcDb();
    expect(await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h" })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("chama distribute_lead com o prazo calculado e o contexto", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_enabled: true } } as any);
    const { db, rpc } = rpcDb("assign-1");
    const id = await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h", now: new Date("2026-10-05T12:00:00Z"), context: { operation: "financing" } });
    expect(id).toBe("assign-1");
    expect(rpc).toHaveBeenCalledWith("distribute_lead", {
      p_organization_id: "o", p_conversation_id: "c", p_handoff_event_id: "h",
      p_sla_due_at: "2026-10-05T12:15:00.000Z", p_context: { operation: "financing" },
    });
  });
  it("propaga o erro do banco para o chamador decidir", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_enabled: true } } as any);
    const { db } = rpcDb(null, { message: "boom" });
    await expect(distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h" })).rejects.toEqual({ message: "boom" });
  });
});

describe("RPC wrappers", () => {
  it("redistributeAssignment envia o novo prazo em ISO", async () => {
    const { db, rpc } = rpcDb("new");
    await redistributeAssignment(db, "a1", new Date("2026-10-05T12:15:00Z"));
    expect(rpc).toHaveBeenCalledWith("redistribute_assignment", { p_assignment_id: "a1", p_new_sla_due_at: "2026-10-05T12:15:00.000Z" });
  });
  it("acceptAssignment e recordHumanMessage mapeiam os parâmetros", async () => {
    const a = rpcDb(true);
    expect(await acceptAssignment(a.db, { assignmentId: "a", actorUserId: "u", actorIsAdmin: false })).toBe(true);
    expect(a.rpc).toHaveBeenCalledWith("accept_assignment", { p_assignment_id: "a", p_actor: "u", p_actor_is_admin: false });
    const b = rpcDb("a");
    await recordHumanMessage(b.db, { organizationId: "o", conversationId: "c", at: new Date("2026-10-05T12:00:00Z"), authorUserId: null, via: "phone_echo" });
    expect(b.rpc).toHaveBeenCalledWith("record_human_message", { p_organization_id: "o", p_conversation_id: "c", p_at: "2026-10-05T12:00:00.000Z", p_author: null, p_via: "phone_echo" });
  });
});
