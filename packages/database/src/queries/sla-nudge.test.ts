import { describe, expect, it } from "vitest";
import { getAssignmentForNudge, getLastNudgeAt, listContactsByIds, recordNudge } from "./lead-distribution.js";

/** Builder encadeável e "await-able" que registra as chamadas por tabela; `results` pode ser lista (uma resposta por chamada de from). */
function db(results: Record<string, { data?: unknown; error?: unknown } | Array<{ data?: unknown; error?: unknown }>>) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const counters: Record<string, number> = {};
  const from = (table: string) => {
    const entry = { table, ops: [] as Array<[string, unknown[]]> };
    calls.push(entry);
    const r0 = results[table];
    const r = (Array.isArray(r0) ? r0[Math.min(counters[table] ?? 0, r0.length - 1)] : r0) ?? { data: [], error: null };
    counters[table] = (counters[table] ?? 0) + 1;
    const c: any = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === "then") return (res: any) => res({ data: r.data ?? null, error: r.error ?? null });
        return (...args: unknown[]) => { entry.ops.push([prop, args]); return c; };
      },
    });
    return c;
  };
  return { db: { from } as any, calls };
}
const has = (call: { ops: Array<[string, unknown[]]> }, op: string, ...args: unknown[]) => expect(call.ops).toContainEqual([op, args]);

describe("getLastNudgeAt (único controle do limite de 2 h)", () => {
  it("filtra pelo prefixo da chave, mais recente primeiro, uma linha", async () => {
    const { db: d, calls } = db({ push_notification_log: { data: { created_at: "2026-11-09T10:00:00Z" } } });
    expect((await getLastNudgeAt(d, "nudge:a1:"))?.toISOString()).toBe("2026-11-09T10:00:00.000Z");
    has(calls[0], "like", "dedupe_key", "nudge:a1:%");
    has(calls[0], "order", "created_at", { ascending: false });
    has(calls[0], "limit", 1);
    expect(calls[0].ops.map(([n]) => n)).toContain("maybeSingle");
  });
  it("sem registro: null; erro propaga", async () => {
    expect(await getLastNudgeAt(db({ push_notification_log: { data: null } }).db, "nudge:a1:")).toBeNull();
    await expect(getLastNudgeAt(db({ push_notification_log: { error: new Error("boom") } }).db, "nudge:a1:")).rejects.toThrow("boom");
  });
});

describe("recordNudge", () => {
  it("insere {dedupe_key, user_id, created_at} com o instante na chave", async () => {
    const { db: d, calls } = db({ push_notification_log: { data: null } });
    const at = new Date("2026-11-09T12:00:00Z");
    await recordNudge(d, "nudge:a1:", "u1", at);
    expect(calls[0].table).toBe("push_notification_log");
    has(calls[0], "insert", { dedupe_key: `nudge:a1:${at.getTime()}`, user_id: "u1", created_at: at.toISOString() });
  });
  it("erro propaga", async () => {
    await expect(recordNudge(db({ push_notification_log: { error: new Error("x") } }).db, "p:", "u", new Date())).rejects.toThrow("x");
  });
});

describe("listContactsByIds", () => {
  it("de-duplica e busca em lotes de 100 filtrando pela organização", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const { db: d, calls } = db({ wa_contacts: [{ data: [{ id: "c0", name: "Ana", phone: "1" }] }, { data: [{ id: "c100", name: null, phone: "2" }] }, { data: [] }] });
    const out = await listContactsByIds(d, "org", [...ids, ...ids.slice(0, 10)]);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (c.ops.find(([n]) => n === "in")![1][1] as string[]).length)).toEqual([100, 100, 50]);
    for (const c of calls) { has(c, "eq", "organization_id", "org"); has(c, "select", "id, name, phone"); }
    expect(out).toEqual([{ id: "c0", name: "Ana", phone: "1" }, { id: "c100", name: null, phone: "2" }]);
  });
  it("lista vazia não consulta", async () => {
    const { db: d, calls } = db({});
    expect(await listContactsByIds(d, "org", [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("getAssignmentForNudge", () => {
  it("filtra por organização e id; null se não existir", async () => {
    const row = { id: "a1", rep_id: "r1" };
    const { db: d, calls } = db({ lead_assignments: { data: row } });
    expect(await getAssignmentForNudge(d, "org", "a1")).toEqual(row);
    has(calls[0], "eq", "organization_id", "org");
    has(calls[0], "eq", "id", "a1");
    expect(await getAssignmentForNudge(db({ lead_assignments: { data: null } }).db, "org", "a1")).toBeNull();
  });
});
