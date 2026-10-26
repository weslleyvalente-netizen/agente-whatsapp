import { describe, expect, it } from "vitest";
import { listLatestInboundMessages, markMessagesAiProcessed } from "./unanswered-leads.js";

// Fake mínimo do query builder do Supabase: encadeia e resolve com as linhas pedidas em range().
function fakeDb(rows: any[], updates: any[] = []) {
  const calls: Array<[number, number]> = [];
  const builder: any = {
    select: () => builder, eq: () => builder, gte: () => builder, lte: () => builder, not: () => builder, is: () => builder, order: () => builder,
    range: async (a: number, b: number) => { calls.push([a, b]); return { data: rows.slice(a, b + 1), error: null }; },
    update: (v: any) => ({ eq: async (_c: string, id: string) => { updates.push({ id, v }); return { error: null }; } }),
    then: (res: any) => res({ data: rows, error: null }),
  };
  return { db: { from: () => builder } as any, calls };
}
const row = (i: number, conv = `c${i}`) => ({
  id: `m${i}`, conversation_id: conv, content: "oi", media_type: null, created_at: "2026-10-26T10:00:00Z",
  metadata: i % 2 ? { ai_routed_at: "x" } : null,
  conversations: { id: conv, evolution_instance_id: "i", is_human_takeover: false, contact_id: "ct", wa_contacts: [{ id: "ct", name: "J", phone: "5511", ai_disabled: false }] },
});

describe("listLatestInboundMessages", () => {
  it("pagina além de 1000 linhas e fica com a mensagem mais nova de cada conversa", async () => {
    const rows = [...Array.from({ length: 1500 }, (_, i) => row(i, i < 1200 ? `c${i}` : "c0"))];
    const { db, calls } = fakeDb(rows);
    const out = await listLatestInboundMessages(db, "org", new Date());
    expect(calls.length).toBeGreaterThan(1);
    expect(out).toHaveLength(1200);
    expect(out[0]).toMatchObject({ messageId: "m0", contactPhone: "5511", aiRoutedAt: null });
    expect(out[1].aiRoutedAt).toBe("x");
  });
});

describe("markMessagesAiProcessed", () => {
  it("mescla ai_processed_at preservando o metadata existente", async () => {
    const updates: any[] = [];
    const { db } = fakeDb([{ id: "m1", metadata: { ai_routed_at: "x", duration_seconds: 3 } }], updates);
    expect(await markMessagesAiProcessed(db, "c", new Date(), "T")).toBe(1);
    expect(updates[0]).toEqual({ id: "m1", v: { metadata: { ai_routed_at: "x", duration_seconds: 3, ai_processed_at: "T" } } });
  });
});
