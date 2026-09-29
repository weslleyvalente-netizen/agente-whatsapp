import { describe, it, expect } from "vitest";
import { setMessageEvolutionId } from "./messages.js";

// Minimal fake covering .from("messages").update(...).eq("id", ...).select().single(),
// same style as the inline fakes used elsewhere in this package's query tests.
type Row = Record<string, unknown>;

function makeFakeClient(initialMessages: Row[]) {
  const messages: Row[] = [...initialMessages];

  return {
    from(table: string) {
      if (table !== "messages") throw new Error(`unexpected table ${table}`);
      let filterId: string | undefined;
      let payload: Row | undefined;

      const builder = {
        update(changes: Row) {
          payload = changes;
          return builder;
        },
        eq(col: string, val: unknown) {
          if (col === "id") filterId = val as string;
          return builder;
        },
        select: () => builder,
        async single() {
          const row = messages.find((m) => m.id === filterId);
          if (!row) return { data: null, error: { message: "not found" } };
          Object.assign(row, payload);
          return { data: row, error: null };
        },
      };
      return builder;
    },
  };
}

describe("setMessageEvolutionId", () => {
  it("updates evolution_message_id and returns the updated row", async () => {
    const client = makeFakeClient([
      { id: "msg-1", evolution_message_id: null, content: "oi" },
    ]);

    const result = await setMessageEvolutionId(client as never, "msg-1", "EVO123");

    expect(result).toMatchObject({ id: "msg-1", evolution_message_id: "EVO123" });
  });

  it("throws when the message does not exist", async () => {
    const client = makeFakeClient([]);

    await expect(setMessageEvolutionId(client as never, "missing", "EVO123")).rejects.toThrow();
  });
});
