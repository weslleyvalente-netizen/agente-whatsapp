import { describe, it, expect } from "vitest";
import {
  createTaskFollowupSend,
  getLastFollowupSendForInstance,
  countFollowupSendsForInstanceSince,
  getFollowupMetrics,
} from "./task-followup-sends.js";

// Small in-memory fake covering exactly the chains this file's queries
// issue: insert().select().single(), select().eq()...order().limit().maybeSingle(),
// select().eq()...gte()... (awaitable directly, array result) — same style
// as tasks-consolidation.test.ts's fake.
type Row = Record<string, unknown>;

function makeFakeClient(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let nextId = 1;

  function table(name: string) {
    if (name !== "task_followup_sends") throw new Error(`unexpected table ${name}`);
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "insert" = "select";
    let payload: Row | undefined;

    const resolveMatches = () => rows.filter((row) => filters.every((f) => f(row)));

    const builder: any = {
      select: () => builder,
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        return builder;
      },
      gte(col: string, val: unknown) {
        filters.push((row) => (row[col] as string) >= (val as string));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      insert(row: Row) {
        mode = "insert";
        payload = row;
        return builder;
      },
      async maybeSingle() {
        const matches = resolveMatches();
        matches.sort((a, b) => ((a.sent_at as string) < (b.sent_at as string) ? 1 : -1));
        return { data: matches[0] ?? null, error: null };
      },
      async single() {
        const newRow: Row = { id: `send-${nextId++}`, sent_at: new Date().toISOString(), ...payload };
        rows.push(newRow);
        return { data: newRow, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: resolveMatches(), error: null });
      },
    };
    return builder;
  }

  return { from: (name: string) => table(name) } as any;
}

describe("createTaskFollowupSend", () => {
  it("inserts a row and returns it", async () => {
    const client = makeFakeClient();

    const result = await createTaskFollowupSend(client, {
      organization_id: "org-1",
      instance_id: "inst-1",
      task_id: "task-1",
      conversation_id: "conv-1",
      message_id: "msg-1",
      suggestion_status: "original",
      regenerations_before_send: 0,
      sent_by_type: "human",
      sent_by_id: "user-1",
    });

    expect(result).toMatchObject({ instance_id: "inst-1", suggestion_status: "original" });
  });
});

describe("getLastFollowupSendForInstance", () => {
  it("returns the most recent send for the instance", async () => {
    const client = makeFakeClient([
      { id: "s1", instance_id: "inst-1", sent_at: "2026-09-29T10:00:00Z" },
      { id: "s2", instance_id: "inst-1", sent_at: "2026-09-29T11:00:00Z" },
      { id: "s3", instance_id: "inst-2", sent_at: "2026-09-29T12:00:00Z" },
    ]);

    const result = await getLastFollowupSendForInstance(client, "inst-1");

    expect(result?.id).toBe("s2");
  });

  it("returns null when the instance has no sends", async () => {
    const client = makeFakeClient([]);
    expect(await getLastFollowupSendForInstance(client, "inst-1")).toBeNull();
  });
});

describe("countFollowupSendsForInstanceSince", () => {
  it("counts only sends for the instance at or after the given time", async () => {
    const client = makeFakeClient([
      { id: "s1", instance_id: "inst-1", sent_at: "2026-09-29T00:00:00Z" }, // before window
      { id: "s2", instance_id: "inst-1", sent_at: "2026-09-29T10:00:00Z" },
      { id: "s3", instance_id: "inst-1", sent_at: "2026-09-29T11:00:00Z" },
      { id: "s4", instance_id: "inst-2", sent_at: "2026-09-29T10:00:00Z" }, // other instance
    ]);

    const count = await countFollowupSendsForInstanceSince(client, "inst-1", "2026-09-29T06:00:00Z");

    expect(count).toBe(2);
  });
});

describe("getFollowupMetrics", () => {
  it("aggregates total/original/edited for the organization since a date", async () => {
    const client = makeFakeClient([
      { id: "s1", organization_id: "org-1", suggestion_status: "original", sent_at: "2026-09-29T10:00:00Z" },
      { id: "s2", organization_id: "org-1", suggestion_status: "edited", sent_at: "2026-09-29T11:00:00Z" },
      { id: "s3", organization_id: "org-1", suggestion_status: "edited", sent_at: "2026-09-29T12:00:00Z" },
      { id: "s4", organization_id: "org-2", suggestion_status: "original", sent_at: "2026-09-29T10:00:00Z" },
    ]);

    const result = await getFollowupMetrics(client, "org-1", "2026-09-29T00:00:00Z");

    expect(result).toEqual({ total: 3, original: 1, edited: 2 });
  });
});
