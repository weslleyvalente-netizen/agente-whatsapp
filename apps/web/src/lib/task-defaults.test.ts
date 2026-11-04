import { describe, it, expect } from "vitest";
import { initialAssigneeValue } from "./task-defaults";

describe("initialAssigneeValue", () => {
  it("keeps the assignee of an edited task", () => {
    expect(initialAssigneeValue({ assignee_type: "human", assignee_id: "u1" }, "me")).toBe("human:u1");
    expect(initialAssigneeValue({ assignee_type: "ai", assignee_id: null }, "me")).toBe("ai");
    expect(initialAssigneeValue({ assignee_type: null, assignee_id: null }, "me")).toBe("none");
  });
  it("assigns a new task to the current user when known, otherwise nobody", () => {
    expect(initialAssigneeValue(null, "me")).toBe("human:me");
    expect(initialAssigneeValue(null, null)).toBe("none");
    expect(initialAssigneeValue(null)).toBe("none");
  });
});
