import { describe, expect, it } from "vitest";
import { getAdOriginForContact } from "./lead-ad-origin.service.js";

type Row = { id: string; organization_id: string; contact_id: string; touched_at: string; conversation_id: string | null; platform: string };

// Banco em memória que aplica de verdade os filtros usados pela consulta (eq, lte, in, order, limit, contagem).
function fakeDb(rows: Row[], opts: { error?: unknown } = {}) {
  const queries: Array<{ filters: Array<[string, string, unknown]>; limit?: number; asc?: boolean; head?: boolean }> = [];
  const from = () => {
    const q = { filters: [] as Array<[string, string, unknown]>, limit: undefined as number | undefined, asc: false, head: false };
    queries.push(q);
    const api: Record<string, any> = {};
    api.select = (_c: string, o?: { head?: boolean }) => { q.head = !!o?.head; return api; };
    api.eq = (c: string, v: unknown) => { q.filters.push(["eq", c, v]); return api; };
    api.lte = (c: string, v: unknown) => { q.filters.push(["lte", c, v]); return api; };
    api.in = (c: string, v: unknown) => { q.filters.push(["in", c, v]); return api; };
    api.order = (_c: string, o?: { ascending?: boolean }) => { q.asc = o?.ascending !== false; return api; };
    api.limit = (n: number) => { q.limit = n; return api; };
    api.then = (resolve: (v: unknown) => unknown) => {
      if (opts.error) return resolve({ data: null, error: opts.error, count: null });
      let out = rows.filter((r) => q.filters.every(([op, c, v]) => {
        const x = (r as any)[c];
        if (op === "eq") return x === v;
        if (op === "lte") return Date.parse(x) <= Date.parse(v as string);
        return (v as unknown[]).includes(x);
      }));
      const count = out.length;
      out = [...out].sort((a, b) => (q.asc ? 1 : -1) * (Date.parse(a.touched_at) - Date.parse(b.touched_at)));
      if (q.limit !== undefined) out = out.slice(0, q.limit);
      return resolve(q.head ? { data: null, error: null, count } : { data: out, error: null, count });
    };
    return api;
  };
  return { db: { from } as never, queries };
}

const ORG = "o", C = "c";
const row = (id: string, touched_at: string, conversation_id: string | null = null): Row => ({ id, organization_id: ORG, contact_id: C, touched_at, conversation_id, platform: "instagram" });
const days = (n: number) => new Date(Date.parse("2026-11-13T12:00:00Z") - n * 86_400_000).toISOString();
const CREATED = "2026-11-13T12:00:00Z";

describe("getAdOriginForContact", () => {
  it("fora de oportunidade: histórico, total, primeiro toque; sem atribuição", async () => {
    const r = await getAdOriginForContact(fakeDb([row("b", days(1)), row("a", days(5))]).db, ORG, C);
    expect(r).toMatchObject({ total_touches: 2, first_touch_id: "a", attributed_touch_id: null, attribution: null });
    expect(r.touches.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("filtra sempre pela organização e pelo contato", async () => {
    const f = fakeDb([row("a", days(1))]);
    await getAdOriginForContact(f.db, ORG, C, { createdAt: CREATED, conversationIds: ["v1"] });
    for (const q of f.queries) {
      expect(q.filters).toContainEqual(["eq", "organization_id", ORG]);
      expect(q.filters).toContainEqual(["eq", "contact_id", C]);
    }
  });

  describe("mais de 50 toques", () => {
    // 60 toques, do mais novo (t0, ontem) ao mais antigo (t59, 60 dias atrás)
    const many = Array.from({ length: 60 }, (_, i) => row(`t${i}`, days(1 + i)));

    it("o primeiro anúncio é o mais antigo de verdade, mesmo fora da lista de 50, e o total é o real", async () => {
      const r = await getAdOriginForContact(fakeDb(many).db, ORG, C);
      expect(r.total_touches).toBe(60);
      expect(r.first_touch_id).toBe("t59");
      expect(r.touches.some((t) => t.id === "t59")).toBe(true);
      expect(r.touches.length).toBeLessThanOrEqual(51);
    });

    it("o toque ligado à conversa do negócio entra mesmo estando além dos 50 mais recentes", async () => {
      const rows = [...many.slice(0, 55), row("antigo-da-conversa", days(58), "v1"), ...many.slice(55)];
      const r = await getAdOriginForContact(fakeDb(rows).db, ORG, C, { createdAt: CREATED, conversationIds: ["v1"] });
      expect(r.attribution).toBe("conversation");
      expect(r.attributed_touch_id).toBe("antigo-da-conversa");
      expect(r.touches.some((t) => t.id === "antigo-da-conversa")).toBe(true);
    });

    it("negócio antigo: o toque certo (até a criação) é achado mesmo com 50 toques mais novos depois dele", async () => {
      const opportunityCreated = days(30);
      const r = await getAdOriginForContact(fakeDb(many).db, ORG, C, { createdAt: opportunityCreated });
      // toques até a criação: t29 (31 dias atrás) em diante; o mais recente até a criação dentro da janela de 14 dias
      expect(r.attribution).toBe("time");
      expect(r.attributed_touch_id).toBe("t29");
      expect(r.touches.some((t) => t.id === "t29")).toBe(true);
    });
  });

  it("prioriza o anúncio da conversa do negócio e evita atribuir anúncio antigo sem relação (indeterminada)", async () => {
    const withLink = await getAdOriginForContact(fakeDb([row("recente", days(1)), row("da-conversa", days(4), "v1")]).db, ORG, C, { createdAt: CREATED, conversationIds: ["v1"] });
    expect(withLink).toMatchObject({ attribution: "conversation", attributed_touch_id: "da-conversa" });
    const old = await getAdOriginForContact(fakeDb([row("velho", days(60))]).db, ORG, C, { createdAt: CREATED, conversationIds: ["v1"] });
    expect(old).toMatchObject({ attribution: "indeterminate", attributed_touch_id: null });
    expect(old.touches.map((t) => t.id)).toEqual(["velho"]);
  });

  it("sem toques: nada a atribuir; erro do banco sobe", async () => {
    expect(await getAdOriginForContact(fakeDb([]).db, ORG, C, { createdAt: CREATED })).toMatchObject({ total_touches: 0, first_touch_id: null, touches: [], attribution: "indeterminate" });
    await expect(getAdOriginForContact(fakeDb([], { error: { message: "x" } }).db, ORG, C)).rejects.toBeTruthy();
  });
});
