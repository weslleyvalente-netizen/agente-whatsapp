import { describe, it, expect } from "vitest";
import { getExpiredTakeovers } from "./conversations.js";

// Minimal fake Supabase client covering just the two `.from()` chains
// getExpiredTakeovers issues: conversations (select + eq) and handoff_events
// (select + eq + is), modeled after the style in tasks.test.ts.
function makeFakeClient(conversations: Record<string, unknown>[], openRequestHumanConvIds: string[]) {
  const from = (table: string) => {
    if (table === "conversations") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: conversations, error: null }),
        }),
      };
    }
    if (table === "handoff_events") {
      return {
        select: () => ({
          eq: () => ({
            is: () =>
              Promise.resolve({
                data: openRequestHumanConvIds.map((conversation_id) => ({ conversation_id })),
                error: null,
              }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  return { from } as any;
}

const timedOutConversation = {
  id: "conv-1",
  is_human_takeover: true,
  human_takeover_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
  organizations: { settings: {} },
};

describe("getExpiredTakeovers", () => {
  it("includes a timed-out conversation with no open request_human handoff (unchanged behavior)", async () => {
    const client = makeFakeClient([timedOutConversation], []);

    const result = await getExpiredTakeovers(client, 30 * 60 * 1000);

    expect(result.map((c) => c.id)).toEqual(["conv-1"]);
  });

  // The core of this change: a requestHuman-originated handoff must never
  // auto-resume on the normal timer -- it only ends via a real human reply
  // or the separate "handoff sem resposta" alert, even after the same 30min
  // of inactivity that would otherwise release it.
  it("excludes a timed-out conversation that has an open request_human handoff", async () => {
    const client = makeFakeClient([timedOutConversation], ["conv-1"]);

    const result = await getExpiredTakeovers(client, 30 * 60 * 1000);

    expect(result).toEqual([]);
  });

  it("does not exclude a different conversation just because another one has an open request_human handoff", async () => {
    const otherConversation = { ...timedOutConversation, id: "conv-2" };
    const client = makeFakeClient([timedOutConversation, otherConversation], ["conv-1"]);

    const result = await getExpiredTakeovers(client, 30 * 60 * 1000);

    expect(result.map((c) => c.id)).toEqual(["conv-2"]);
  });
});
