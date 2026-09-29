import { describe, it, expect } from "vitest";
import { getExpiredTakeovers, findOpenConversationByContact } from "./conversations.js";

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

// Task→conversation fallback for the follow-up-from-task feature (D2): a
// task without conversation_id can still send if the contact has an open
// conversation, regardless of which agent it's with — unlike
// findOpenConversation, which requires a matching agent_id.
function makeContactConversationsClient(conversations: Record<string, unknown>[]) {
  const from = (table: string) => {
    if (table !== "conversations") throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    return {
      select: () => ({
        eq(col: string, val: unknown) {
          filters.push((row) => row[col] === val);
          return this;
        },
        in(col: string, vals: unknown[]) {
          filters.push((row) => vals.includes(row[col]));
          return this;
        },
        order: () => ({
          limit: () => ({
            async maybeSingle() {
              const matches = conversations
                .filter((row) => filters.every((f) => f(row)))
                .sort((a, b) => ((a.created_at as string) < (b.created_at as string) ? 1 : -1));
              return { data: matches[0] ?? null, error: null };
            },
          }),
        }),
      }),
    };
  };
  return { from } as any;
}

describe("findOpenConversationByContact", () => {
  it("returns the most recent open/waiting conversation for the contact, any agent", async () => {
    const client = makeContactConversationsClient([
      { id: "conv-old", contact_id: "contact-1", status: "open", created_at: "2026-01-01T00:00:00Z" },
      { id: "conv-new", contact_id: "contact-1", status: "waiting", created_at: "2026-02-01T00:00:00Z" },
    ]);

    const result = await findOpenConversationByContact(client, "contact-1");

    expect(result?.id).toBe("conv-new");
  });

  it("returns null when the contact has no open/waiting conversation", async () => {
    const client = makeContactConversationsClient([
      { id: "conv-closed", contact_id: "contact-1", status: "closed", created_at: "2026-01-01T00:00:00Z" },
    ]);

    const result = await findOpenConversationByContact(client, "contact-1");

    expect(result).toBeNull();
  });
});
