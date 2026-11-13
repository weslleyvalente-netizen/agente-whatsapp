import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getAdOriginForOpportunity } from "./lead-ad-origin.service.js";

interface Scenario {
  name: string; contact: string;
  opportunity: { id: string; created_at: string; linked_conversations: string[] };
  touches: Array<{ id: string; touched_at: string; conversation_id: string | null }>;
  expected: { touch_id: string | null; basis: "conversation" | "estimated" | "indeterminate" };
}
const file = resolve(__dirname, "../../../../supabase/tests/ad-attribution-scenarios.json");
const { organization: ORG, scenarios } = JSON.parse(readFileSync(file, "utf8")) as { organization: string; scenarios: Scenario[] };

type Table = "lead_ad_touches" | "lead_assignments";
// Banco em memória que aplica os filtros usados pelas consultas (eq, lte, in, not null, order, limit, contagem).
function fakeDb(data: Record<Table, Array<Record<string, unknown>>>) {
  return {
    from: (table: Table) => {
      const f: Array<[string, string, unknown]> = []; let asc = false, limit: number | undefined, head = false;
      const api: Record<string, any> = {};
      api.select = (_c: string, o?: { head?: boolean }) => { head = !!o?.head; return api; };
      api.eq = (c: string, v: unknown) => { f.push(["eq", c, v]); return api; };
      api.lte = (c: string, v: unknown) => { f.push(["lte", c, v]); return api; };
      api.in = (c: string, v: unknown) => { f.push(["in", c, v]); return api; };
      api.not = (c: string, op: string, v: unknown) => { f.push(["not", c, v]); return api; };
      api.order = (_c: string, o?: { ascending?: boolean }) => { asc = o?.ascending !== false; return api; };
      api.limit = (n: number) => { limit = n; return api; };
      api.then = (resolve: (v: unknown) => unknown) => {
        let out = data[table].filter((r) => f.every(([op, c, v]) => {
          const x = r[c];
          if (op === "eq") return x === v;
          if (op === "lte") return Date.parse(x as string) <= Date.parse(v as string);
          if (op === "not") return x !== v;
          return (v as unknown[]).includes(x);
        }));
        const count = out.length;
        if (out[0] && "touched_at" in out[0]) out = [...out].sort((a, b) => (asc ? 1 : -1) * (Date.parse(a.touched_at as string) - Date.parse(b.touched_at as string)));
        if (limit !== undefined) out = out.slice(0, limit);
        return resolve(head ? { data: null, error: null, count } : { data: out, error: null, count });
      };
      return api;
    },
  } as never;
}

describe("atribuição por cenário (a view SQL é validada contra estes mesmos cenários)", () => {
  for (const s of scenarios) {
    it(s.name, async () => {
      const db = fakeDb({
        lead_ad_touches: s.touches.map((t) => ({ ...t, organization_id: ORG, contact_id: s.contact, platform: "instagram" })),
        lead_assignments: s.opportunity.linked_conversations.map((c) => ({ organization_id: ORG, opportunity_id: s.opportunity.id, conversation_id: c })),
      });
      const r = await getAdOriginForOpportunity(db, { id: s.opportunity.id, organization_id: ORG, contact_id: s.contact, created_at: s.opportunity.created_at });
      expect({ touch_id: r.attributed_touch_id, basis: r.attribution }).toEqual(s.expected);
    });
  }

  it("a conversa vem do vínculo da oportunidade (lead_assignments), não da conversa mais recente do contato", async () => {
    const s = scenarios[0]; // vinculada só a v1; v2 é a conversa mais recente do contato
    const db = fakeDb({
      lead_ad_touches: s.touches.map((t) => ({ ...t, organization_id: ORG, contact_id: s.contact, platform: "instagram" })),
      lead_assignments: [{ organization_id: ORG, opportunity_id: s.opportunity.id, conversation_id: "v1" }, { organization_id: ORG, opportunity_id: "outra-oportunidade", conversation_id: "v2" }],
    });
    const r = await getAdOriginForOpportunity(db, { id: s.opportunity.id, organization_id: ORG, contact_id: s.contact, created_at: s.opportunity.created_at });
    expect(r.attributed_touch_id).toBe("A");
  });
});
