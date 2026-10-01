import { describe, expect, it } from "vitest";
import {
  buildConsolidatedDescription,
  earliestDueDate,
  pickPrimaryPendency,
  removePendencyByType,
  upsertPendency,
} from "./task-consolidation.js";
import type { TaskPendency } from "./types/task.js";

function pendency(overrides: Partial<TaskPendency> = {}): TaskPendency {
  return {
    type: "financing_followup",
    description: "Retornar com resultado da simulação.",
    reason: null,
    priority: "normal",
    due_date: "2026-10-01",
    due_time: null,
    added_at: "2026-09-28T12:00:00.000Z",
    added_by_type: "ai",
    added_by_id: null,
    ...overrides,
  };
}

describe("upsertPendency", () => {
  it("appends a pendency of a new type to an empty list", () => {
    const result = upsertPendency([], pendency());
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("financing_followup");
  });

  it("appends a pendency of a different type alongside an existing one", () => {
    const existing = [pendency({ type: "financing_followup" })];
    const result = upsertPendency(existing, pendency({ type: "request_documents" }));
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.type).sort()).toEqual(["financing_followup", "request_documents"]);
  });

  it("updates the existing entry in place when the same type arrives again, instead of duplicating", () => {
    const existing = [pendency({ type: "financing_followup", description: "old", due_date: "2026-10-01" })];
    const result = upsertPendency(
      existing,
      pendency({ type: "financing_followup", description: "new", due_date: "2026-10-05" })
    );
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("new");
    expect(result[0].due_date).toBe("2026-10-05");
  });
});

describe("removePendencyByType", () => {
  it("removes the matching entry and leaves the rest untouched", () => {
    const existing = [pendency({ type: "financing_followup" }), pendency({ type: "request_documents" })];
    const result = removePendencyByType(existing, "financing_followup");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("request_documents");
  });

  it("is a no-op when the type isn't present", () => {
    const existing = [pendency({ type: "financing_followup" })];
    const result = removePendencyByType(existing, "request_documents");
    expect(result).toEqual(existing);
  });

  it("can empty the list entirely", () => {
    const existing = [pendency({ type: "financing_followup" })];
    expect(removePendencyByType(existing, "financing_followup")).toEqual([]);
  });
});

describe("pickPrimaryPendency", () => {
  it("returns null for an empty list", () => {
    expect(pickPrimaryPendency([])).toBeNull();
  });

  it("picks the highest-priority pendency, not the most recent", () => {
    const low = pendency({ type: "customer_unresponsive", priority: "low", added_at: "2026-09-28T12:00:00.000Z" });
    const urgent = pendency({
      type: "awaiting_customer_cpf",
      priority: "urgent",
      added_at: "2026-09-20T00:00:00.000Z",
    });
    expect(pickPrimaryPendency([low, urgent])!.type).toBe("awaiting_customer_cpf");
  });

  it("breaks a priority tie by the earliest due_date", () => {
    const later = pendency({ type: "financing_followup", priority: "high", due_date: "2026-10-10" });
    const sooner = pendency({ type: "request_documents", priority: "high", due_date: "2026-09-30" });
    expect(pickPrimaryPendency([later, sooner])!.type).toBe("request_documents");
  });

  it("breaks a priority+due_date tie by the earliest added_at", () => {
    const newer = pendency({
      type: "financing_followup",
      priority: "high",
      due_date: "2026-10-01",
      added_at: "2026-09-28T12:00:00.000Z",
    });
    const older = pendency({
      type: "request_documents",
      priority: "high",
      due_date: "2026-10-01",
      added_at: "2026-09-20T09:00:00.000Z",
    });
    expect(pickPrimaryPendency([newer, older])!.type).toBe("request_documents");
  });
});

describe("earliestDueDate", () => {
  it("returns null for an empty list", () => {
    expect(earliestDueDate([])).toBeNull();
  });

  it("returns the soonest due_date across every open pendency, not just the primary one", () => {
    const list = [
      pendency({ type: "financing_followup", priority: "urgent", due_date: "2026-10-10" }),
      pendency({ type: "request_documents", priority: "low", due_date: "2026-09-29" }),
    ];
    expect(earliestDueDate(list)).toBe("2026-09-29");
  });
});

describe("buildConsolidatedDescription", () => {
  it("describes a single pendency plainly", () => {
    const list = [pendency({ description: "Retornar com resultado da simulação." })];
    expect(buildConsolidatedDescription(list)).toBe("Retornar com resultado da simulação.");
  });

  it("leads with the primary pendency and lists the rest", () => {
    const list = [
      pendency({ type: "awaiting_customer_cpf", priority: "urgent", description: "Aguardando CPF do cliente." }),
      pendency({ type: "financing_followup", priority: "normal", description: "Retornar com a simulação." }),
    ];
    const description = buildConsolidatedDescription(list);
    expect(description).toContain("Aguardando CPF do cliente.");
    expect(description).toContain("Retornar com a simulação.");
  });
});

it("não substitui o retorno do congelamento por callback automático",()=>{
 const frozen={...pendency({type:"scheduled_callback",due_date:"2026-11-01"}),freeze_opportunity_id:"opp"};
 expect(upsertPendency([frozen],pendency({type:"scheduled_callback",due_date:"2026-10-02"}))[0].due_date).toBe("2026-11-01");
});
