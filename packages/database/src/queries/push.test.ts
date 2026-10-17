import { describe, expect, it, vi } from "vitest";
import {
  claimPushDedupe, deletePushSubscription, listCustomerMessageCandidates, listNewAssignmentCandidates,
  listSlaRiskCandidates, upsertPushSubscription,
} from "./push.js";

/** Builder encadeável e "await-able" que registra as chamadas e devolve `result` por tabela. */
function db(results: Record<string, { data?: unknown; error?: unknown }>) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const from = (table: string) => {
    const entry = { table, ops: [] as Array<[string, unknown[]]> };
    calls.push(entry);
    const c: any = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === "then") { const r = results[table] ?? { data: [], error: null }; return (res: any) => res({ data: r.data ?? null, error: r.error ?? null }); }
        return (...args: unknown[]) => { entry.ops.push([prop, args]); return c; };
      },
    });
    return c;
  };
  return { db: { from } as any, calls };
}

describe("subscriptions", () => {
  it("upsert por endpoint", async () => {
    const { db: d, calls } = db({ push_subscriptions: { data: { id: "s" } } });
    await upsertPushSubscription(d, { organizationId: "o", userId: "u", endpoint: "e", p256dh: "p", auth: "a", userAgent: "ua" });
    const upsert = calls[0].ops.find(([n]) => n === "upsert")!;
    expect((upsert[1][0] as any)).toMatchObject({ organization_id: "o", user_id: "u", endpoint: "e" });
    expect(upsert[1][1]).toEqual({ onConflict: "endpoint" });
  });
  it("unsubscribe só apaga do próprio usuário", async () => {
    const { db: d, calls } = db({ push_subscriptions: {} });
    await deletePushSubscription(d, "u", "e");
    expect(calls[0].ops).toContainEqual(["eq", ["user_id", "u"]]);
    expect(calls[0].ops).toContainEqual(["eq", ["endpoint", "e"]]);
  });
});

describe("claimPushDedupe", () => {
  it("true quando inseriu, false quando a chave já existia", async () => {
    expect(await claimPushDedupe(db({ push_notification_log: { data: [{ dedupe_key: "k" }] } }).db, "k", "u")).toBe(true);
    expect(await claimPushDedupe(db({ push_notification_log: { data: [] } }).db, "k", "u")).toBe(false);
  });
});

describe("listNewAssignmentCandidates", () => {
  it("monta o texto e a chave assign:{id} para o vendedor da atribuição", async () => {
    const { db: d } = db({ lead_assignments: { data: [
      { id: "a1", organization_id: "o", conversation_id: "c1", sales_reps: { user_id: "u1" }, wa_contacts: { name: "Ana", phone: "55" } },
      { id: "a2", organization_id: "o", conversation_id: "c2", sales_reps: [{ user_id: "u2" }], wa_contacts: { name: null, phone: "5511" } },
      { id: "a3", organization_id: "o", conversation_id: "c3", sales_reps: null, wa_contacts: null },
    ] } });
    const r = await listNewAssignmentCandidates(d, new Date("2026-10-17T12:00:00Z"));
    expect(r).toEqual([
      { organizationId: "o", userId: "u1", dedupeKeys: ["assign:a1"], title: "Novo lead: Ana", body: "Toque para atender.", url: "/inbox?id=c1", tag: "assign-a1" },
      { organizationId: "o", userId: "u2", dedupeKeys: ["assign:a2"], title: "Novo lead: 5511", body: "Toque para atender.", url: "/inbox?id=c2", tag: "assign-a2" },
    ]);
  });
});

describe("listSlaRiskCandidates", () => {
  it("calcula os minutos restantes (arredondando para cima) e usa a chave sla:{id}", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const { db: d, calls } = db({ lead_assignments: { data: [
      { id: "a1", organization_id: "o", conversation_id: "c1", sla_due_at: "2026-10-17T12:04:10Z", sales_reps: { user_id: "u1" }, wa_contacts: { name: "Ana", phone: "55" } },
    ] } });
    const r = await listSlaRiskCandidates(d, now, 15);
    expect(r[0]).toMatchObject({ userId: "u1", dedupeKeys: ["sla:a1"], title: "Responda Ana — faltam 5 min" });
    expect(calls[0].ops).toContainEqual(["gt", ["sla_due_at", now.toISOString()]]);
    expect(calls[0].ops).toContainEqual(["lte", ["sla_due_at", "2026-10-17T12:15:00.000Z"]]);
  });
});

describe("listCustomerMessageCandidates", () => {
  const msg = (id: string, conv: string, content: string, owner: string | null, takeover: boolean, at: string) => ({
    id, content, created_at: at, conversation_id: conv, organization_id: "o",
    conversations: { assigned_to: owner, is_human_takeover: takeover, wa_contacts: { name: "Ana", phone: "55" } },
  });
  it("agrupa por conversa (última mensagem, tag = conversa) e corta o trecho em 80 caracteres", async () => {
    const long = "x".repeat(200);
    const { db: d } = db({ messages: { data: [
      msg("m1", "c1", "oi", "u1", true, "2026-10-17T12:00:00Z"),
      msg("m2", "c1", long, "u1", true, "2026-10-17T12:00:05Z"),
    ] } });
    const r = await listCustomerMessageCandidates(d, new Date("2026-10-17T11:59:00Z"));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ userId: "u1", dedupeKeys: ["msg:m1", "msg:m2"], tag: "c1", url: "/inbox?id=c1", title: "Ana" });
    expect(r[0].body).toBe("x".repeat(80));
  });
  it("ignora conversa sem dono; sem takeover só notifica se nunca houve resposta humana", async () => {
    const { db: d } = db({ messages: { data: [
      msg("m1", "c1", "a", null, true, "2026-10-17T12:00:00Z"),
      msg("m2", "c2", "b", "u2", false, "2026-10-17T12:00:00Z"),
      msg("m3", "c3", "c", "u3", false, "2026-10-17T12:00:00Z"),
    ] } });
    // c3 já teve resposta humana; c2 não
    const from = d.from;
    const humanDb = {
      from: (t: string) => {
        if (t === "messages") {
          const isHuman = { n: 0 };
          const chain: any = new Proxy({}, { get: (_x, p: string) => {
            if (p === "then") return (res: any) => res({ error: null, data: isHuman.n ? [{ conversation_id: "c3" }] : [
              msg("m1", "c1", "a", null, true, "2026-10-17T12:00:00Z"), msg("m2", "c2", "b", "u2", false, "2026-10-17T12:00:00Z"), msg("m3", "c3", "c", "u3", false, "2026-10-17T12:00:00Z") ] });
            return (...a: unknown[]) => { if (p === "eq" && a[0] === "role" && a[1] === "human_agent") isHuman.n = 1; return chain; };
          } });
          return chain;
        }
        return from(t);
      },
    } as any;
    const r = await listCustomerMessageCandidates(humanDb, new Date("2026-10-17T11:59:00Z"));
    expect(r.map(x => x.userId)).toEqual(["u2"]);
  });
});
