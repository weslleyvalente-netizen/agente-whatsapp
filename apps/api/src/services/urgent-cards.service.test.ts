import { describe, expect, it } from "vitest";
import { applyUrgent, buildUrgentByContact, urgentCoverage } from "./urgent-cards.service.js";

const now = new Date("2026-11-23T15:00:00Z");
const alert = (contact: string, at: string) => ({ contact_id: contact, conversation_id: `conv-${contact}`, handoff_at: at, assigned_at: at, reason: "round_robin" });

describe("buildUrgentByContact", () => {
  it("alerta de prazo, exceção e promessa vencida viram urgente; promessa ainda no prazo não", () => {
    const map = buildUrgentByContact({
      alerts: [alert("a", "2026-11-23T13:00:00Z")],
      exceptions: [alert("e", "2026-11-23T12:00:00Z")],
      promises: [
        { contact_id: "p", conversation_id: "conv-p", due_at: "2026-11-23T14:30:00Z" },
        { contact_id: "f", conversation_id: "conv-f", due_at: "2026-11-23T16:00:00Z" },
      ],
    }, now);
    expect(map.get("a")).toEqual({ reason: "sla", since: "2026-11-23T13:00:00Z" });
    expect(map.get("e")).toEqual({ reason: "exception", since: "2026-11-23T12:00:00Z" });
    expect(map.get("p")).toEqual({ reason: "promise", since: "2026-11-23T14:30:00Z" });
    expect(map.has("f")).toBe(false);
  });
  it("atribuição manual conta desde a atribuição (como o quadro antigo)", () => {
    const map = buildUrgentByContact({ alerts: [{ contact_id: "m", conversation_id: "c", handoff_at: "2026-11-20T10:00:00Z", assigned_at: "2026-11-23T14:00:00Z", reason: "manual" }], exceptions: [], promises: [] }, now);
    expect(map.get("m")?.since).toBe("2026-11-23T14:00:00Z");
  });
  it("mesmo contato com dois motivos: fica o que espera há mais tempo", () => {
    const map = buildUrgentByContact({ alerts: [alert("x", "2026-11-23T14:00:00Z")], exceptions: [], promises: [{ contact_id: "x", conversation_id: "c", due_at: "2026-11-23T11:00:00Z" }] }, now);
    expect(map.get("x")).toEqual({ reason: "promise", since: "2026-11-23T11:00:00Z" });
  });
});

describe("applyUrgent", () => {
  it("marca só negócios abertos e preserva o resto do estado do card", () => {
    const map = new Map([["a", { reason: "sla" as const, since: "2026-11-23T13:00:00Z" }]]);
    const rows = applyUrgent([
      { id: "1", contact_id: "a", status: "open", sales_state: { customerReplied: false, taskCount: 2 } },
      { id: "2", contact_id: "a", status: "won", sales_state: { customerReplied: false, taskCount: 0 } },
      { id: "3", contact_id: "b", status: "open" },
    ] as any[], map);
    expect(rows[0].sales_state).toMatchObject({ urgent: { reason: "sla" }, taskCount: 2 });
    expect(rows[1].sales_state?.urgent ?? null).toBeNull();
    expect(rows[2].sales_state?.urgent ?? null).toBeNull();
  });
});

describe("urgentCoverage (prova antes de tirar o quadro antigo)", () => {
  it("todo alerta/exceção do quadro antigo com negócio aberto tem card; os demais aparecem como fora do funil", () => {
    const r = urgentCoverage({ alerts: [alert("a", "x")], exceptions: [alert("sem-negocio", "x")], promises: [] }, new Set(["a"]));
    expect(r).toEqual({ total: 2, covered: 1, uncovered: [{ contactId: "sem-negocio", conversationId: "conv-sem-negocio", reason: "exception" }] });
  });
  it("tudo coberto: uncovered vazio", () => {
    expect(urgentCoverage({ alerts: [alert("a", "x")], exceptions: [], promises: [] }, new Set(["a"])).uncovered).toEqual([]);
  });
});
