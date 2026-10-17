import { describe, it, expect } from "vitest";
import { countAfterHoursAgentReplies } from "./messages.js";

function fakeClient(result: { count: number | null; error: unknown }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const b: any = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result);
      return (...args: unknown[]) => { calls.push([prop, ...args]); return b; };
    },
  });
  return { client: { from: (t: string) => { calls.push(["from", t]); return b; } } as any, calls };
}

describe("countAfterHoursAgentReplies", () => {
  it("filters agent messages flagged after_hours_pending since the handoff and returns the count", async () => {
    const { client, calls } = fakeClient({ count: 7, error: null });
    await expect(countAfterHoursAgentReplies(client, "conv-1", "2026-10-10T00:00:00Z")).resolves.toBe(7);
    expect(calls).toContainEqual(["eq", "conversation_id", "conv-1"]);
    expect(calls).toContainEqual(["eq", "role", "agent"]);
    expect(calls).toContainEqual(["gte", "created_at", "2026-10-10T00:00:00Z"]);
    expect(calls).toContainEqual(["contains", "metadata", { after_hours_pending: true }]);
  });
  it("treats a null count as zero and throws on error", async () => {
    await expect(countAfterHoursAgentReplies(fakeClient({ count: null, error: null }).client, "c", "x")).resolves.toBe(0);
    await expect(countAfterHoursAgentReplies(fakeClient({ count: null, error: new Error("x") }).client, "c", "x")).rejects.toThrow();
  });
});
