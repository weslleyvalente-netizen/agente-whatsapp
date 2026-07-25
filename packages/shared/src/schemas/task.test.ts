import { describe, it, expect } from "vitest";
import { createTaskSchema, updateTaskSchema, rescheduleTaskSchema } from "./task.js";

describe("createTaskSchema", () => {
  const validInput = {
    contact_id: "11111111-1111-1111-1111-111111111111",
    type: "return_customer",
    due_date: "2026-07-26",
  };

  it("accepts the minimal valid input and applies defaults", () => {
    const result = createTaskSchema.parse(validInput);
    expect(result.priority).toBe("normal");
    expect(result.description).toBe("");
  });

  it("rejects a due_date that isn't YYYY-MM-DD", () => {
    expect(() => createTaskSchema.parse({ ...validInput, due_date: "26/07/2026" })).toThrow();
  });

  it("rejects assignee_type human without an assignee_id", () => {
    expect(() => createTaskSchema.parse({ ...validInput, assignee_type: "human" })).toThrow();
  });

  it("rejects assignee_type ai with an assignee_id set", () => {
    expect(() =>
      createTaskSchema.parse({
        ...validInput,
        assignee_type: "ai",
        assignee_id: "22222222-2222-2222-2222-222222222222",
      })
    ).toThrow();
  });

  it("accepts assignee_type human with a matching assignee_id", () => {
    const result = createTaskSchema.parse({
      ...validInput,
      assignee_type: "human",
      assignee_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(result.assignee_id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("rejects an unknown task type", () => {
    expect(() => createTaskSchema.parse({ ...validInput, type: "made_up_type" })).toThrow();
  });

  it("rejects an assignee_id with no assignee_type set", () => {
    expect(() =>
      createTaskSchema.parse({
        ...validInput,
        assignee_id: "22222222-2222-2222-2222-222222222222",
      })
    ).toThrow();
  });
});

describe("updateTaskSchema", () => {
  it("accepts a partial update with unrelated fields only", () => {
    const result = updateTaskSchema.parse({ due_date: "2026-08-01" });
    expect(result).toEqual({ due_date: "2026-08-01" });
  });

  it("rejects an assignee_id with no assignee_type set", () => {
    expect(() =>
      updateTaskSchema.parse({
        assignee_id: "22222222-2222-2222-2222-222222222222",
      })
    ).toThrow();
  });

  it("accepts assignee_type human with a matching assignee_id", () => {
    const result = updateTaskSchema.parse({
      assignee_type: "human",
      assignee_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(result.assignee_id).toBe("22222222-2222-2222-2222-222222222222");
  });
});

describe("rescheduleTaskSchema", () => {
  it("accepts a date with no time", () => {
    expect(rescheduleTaskSchema.parse({ due_date: "2026-08-01" })).toEqual({ due_date: "2026-08-01" });
  });

  it("rejects a malformed time", () => {
    expect(() => rescheduleTaskSchema.parse({ due_date: "2026-08-01", due_time: "9:00" })).toThrow();
  });
});
