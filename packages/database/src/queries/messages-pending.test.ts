import { describe, it, expect } from "vitest";
import { findPendingOutboundMessages, getMessageById } from "./messages.js";

// Small in-memory fake covering select().eq()...is()...in()...gte()...maybeSingle()/then(),
// same style as other query test fakes in this package.
type Row = Record<string, unknown>;

function makeFakeClient(seed: Row[]) {
  const messages: Row[] = [...seed];

  function table() {
    const filters: Array<(row: Row) => boolean> = [];
    const builder: any = {
      select: () => builder,
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(row[col]));
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push((row) => (row[col] ?? null) === val);
        return builder;
      },
      gte(col: string, val: unknown) {
        filters.push((row) => (row[col] as string) >= (val as string));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      async maybeSingle() {
        const matches = messages.filter((row) => filters.every((f) => f(row)));
        return { data: matches[0] ?? null, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: messages.filter((row) => filters.every((f) => f(row))), error: null });
      },
    };
    return builder;
  }

  return {
    from: (name: string) => {
      if (name !== "messages") throw new Error(`unexpected ${name}`);
      return table();
    },
  } as any;
}

describe("findPendingOutboundMessages", () => {
  const base = {
    conversation_id: "conv-1",
    evolution_message_id: null,
    created_at: "2026-09-29T12:00:00.000Z",
  };

  it("returns pending outbound candidates (agent or human_agent) within the window", () => {
    const client = makeFakeClient([
      { id: "m1", role: "agent", content: "oi", media_type: null, ...base },
      { id: "m2", role: "human_agent", content: "oi2", media_type: null, ...base },
    ]);

    return findPendingOutboundMessages(client, "conv-1", "2026-09-29T11:00:00.000Z").then((result) => {
      expect(result.map((r: any) => r.id).sort()).toEqual(["m1", "m2"]);
    });
  });

  it("excludes a contact message even within the window", async () => {
    const client = makeFakeClient([{ id: "m1", role: "contact", content: "oi", media_type: null, ...base }]);
    const result = await findPendingOutboundMessages(client, "conv-1", "2026-09-29T11:00:00.000Z");
    expect(result).toEqual([]);
  });

  it("excludes a message that already has an evolution_message_id", async () => {
    const client = makeFakeClient([
      { id: "m1", role: "agent", content: "oi", media_type: null, ...base, evolution_message_id: "EVO-1" },
    ]);
    const result = await findPendingOutboundMessages(client, "conv-1", "2026-09-29T11:00:00.000Z");
    expect(result).toEqual([]);
  });

  it("excludes a message outside the time window", async () => {
    const client = makeFakeClient([
      { id: "m1", role: "agent", content: "oi", media_type: null, ...base, created_at: "2026-09-29T09:00:00.000Z" },
    ]);
    const result = await findPendingOutboundMessages(client, "conv-1", "2026-09-29T11:00:00.000Z");
    expect(result).toEqual([]);
  });

  it("excludes a different conversation", async () => {
    const client = makeFakeClient([
      { id: "m1", role: "agent", content: "oi", media_type: null, ...base, conversation_id: "conv-2" },
    ]);
    const result = await findPendingOutboundMessages(client, "conv-1", "2026-09-29T11:00:00.000Z");
    expect(result).toEqual([]);
  });
});

describe("getMessageById", () => {
  it("returns the message when it exists", async () => {
    const client = makeFakeClient([{ id: "msg-1", evolution_message_id: "EVO-1" }]);
    const result = await getMessageById(client, "msg-1");
    expect(result?.id).toBe("msg-1");
  });

  it("returns null when it does not exist", async () => {
    const client = makeFakeClient([]);
    const result = await getMessageById(client, "missing");
    expect(result).toBeNull();
  });
});
