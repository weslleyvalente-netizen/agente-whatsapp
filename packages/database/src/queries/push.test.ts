import { describe, expect, it, vi } from "vitest";
import {
  claimPushDedupe, deletePushSubscription, listCustomerMessageCandidates, listNewAssignmentCandidates,
  listSlaRiskCandidates, upsertPushSubscription, releasePushDedupe, purgePushNotificationLog,
  listPushEnabledOrganizationIds, listCurrentMemberIds, listSlaBreachCandidates, listSlaEscalationOrganizationIds,
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

const has = (calls: any[], i: number, op: string, ...args: unknown[]) => expect(calls[i].ops).toContainEqual([op, args]);

describe("subscriptions", () => {
  const sub = { organizationId: "o", userId: "u", endpoint: "e", p256dh: "p", auth: "a", userAgent: "ua" };
  it("upsert por endpoint quando o endpoint é novo", async () => {
    const { db: d, calls } = db({ push_subscriptions: { data: null } });
    expect(await upsertPushSubscription(d, sub)).toBe("ok");
    const upsert = calls[1].ops.find(([n]) => n === "upsert")!;
    expect((upsert[1][0] as any)).toMatchObject({ organization_id: "o", user_id: "u", endpoint: "e" });
    expect(upsert[1][1]).toEqual({ onConflict: "endpoint" });
  });
  it("endpoint de outro usuário com chaves diferentes: conflito, sem gravar", async () => {
    const { db: d, calls } = db({ push_subscriptions: { data: { user_id: "other", p256dh: "x", auth: "y" } } });
    expect(await upsertPushSubscription(d, sub)).toBe("conflict");
    expect(calls).toHaveLength(1);
  });
  it("endpoint de outro usuário com as mesmas chaves (mesmo navegador) é reatribuído", async () => {
    const { db: d } = db({ push_subscriptions: { data: { user_id: "other", p256dh: "p", auth: "a" } } });
    expect(await upsertPushSubscription(d, sub)).toBe("ok");
  });
  it("unsubscribe só apaga do próprio usuário", async () => {
    const { db: d, calls } = db({ push_subscriptions: {} });
    await deletePushSubscription(d, "u", "e");
    has(calls, 0, "eq", "user_id", "u"); has(calls, 0, "eq", "endpoint", "e");
  });
});

describe("dedupe, retenção, organizações e membros", () => {
  it("claim: true quando inseriu, false quando a chave já existia", async () => {
    expect(await claimPushDedupe(db({ push_notification_log: { data: [{ dedupe_key: "k" }] } }).db, "k", "u")).toBe(true);
    expect(await claimPushDedupe(db({ push_notification_log: { data: [] } }).db, "k", "u")).toBe(false);
  });
  it("release apaga as chaves; sem chaves não consulta", async () => {
    const { db: d, calls } = db({ push_notification_log: {} });
    await releasePushDedupe(d, ["a", "b"]); has(calls, 0, "in", "dedupe_key", ["a", "b"]);
    await releasePushDedupe(d, []); expect(calls).toHaveLength(1);
  });
  it("purge apaga o log anterior ao corte", async () => {
    const { db: d, calls } = db({ push_notification_log: {} });
    await purgePushNotificationLog(d, new Date("2026-10-10T00:00:00Z"));
    has(calls, 0, "lt", "created_at", "2026-10-10T00:00:00.000Z");
  });
  it("organizações com a flag ligada", async () => {
    const { db: d, calls } = db({ organizations: { data: [{ id: "o1" }, { id: "o2" }] } });
    expect(await listPushEnabledOrganizationIds(d)).toEqual(["o1", "o2"]);
    has(calls, 0, "eq", "settings->>push_notifications_enabled", "true");
  });
  it("membros atuais", async () => {
    const { db: d, calls } = db({ organization_members: { data: [{ user_id: "u1" }] } });
    expect([...(await listCurrentMemberIds(d, "o", ["u1", "u2"]))]).toEqual(["u1"]);
    has(calls, 0, "eq", "organization_id", "o");
    expect((await listCurrentMemberIds(d, "o", [])).size).toBe(0);
  });
});

describe("listNewAssignmentCandidates", () => {
  const since = new Date("2026-10-17T12:00:00Z");
  it("monta o texto, a chave assign:{id} e a tag da conversa para o vendedor da atribuição", async () => {
    const { db: d } = db({ lead_assignments: { data: [
      { id: "a1", organization_id: "o", conversation_id: "c1", sales_reps: { user_id: "u1" }, wa_contacts: { name: "Ana", phone: "55" } },
      { id: "a2", organization_id: "o", conversation_id: "c2", sales_reps: [{ user_id: "u2" }], wa_contacts: { name: null, phone: "5511999990000" } },
      { id: "a3", organization_id: "o", conversation_id: "c3", sales_reps: null, wa_contacts: null },
    ] } });
    const { candidates, truncatedAt } = await listNewAssignmentCandidates(d, since, ["o"]);
    expect(truncatedAt).toBeNull();
    expect(candidates).toEqual([
      { kind: "assign", organizationId: "o", userId: "u1", dedupeKeys: ["assign:a1"], title: "Novo lead: Ana", body: "Toque para atender.", url: "/inbox?id=c1", tag: "c1" },
      { kind: "assign", organizationId: "o", userId: "u2", dedupeKeys: ["assign:a2"], title: "Novo lead: Cliente", body: "Toque para atender.", url: "/inbox?id=c2", tag: "c2" },
    ]);
  });
  it("aplica os filtros de segurança e escopo", async () => {
    const { db: d, calls } = db({ lead_assignments: { data: [] } });
    await listNewAssignmentCandidates(d, since, ["o1"]);
    has(calls, 0, "in", "organization_id", ["o1"]); has(calls, 0, "eq", "status", "pending");
    has(calls, 0, "not", "rep_id", "is", null); has(calls, 0, "gte", "created_at", since.toISOString());
  });
  it("sem organizações ligadas não consulta o banco", async () => {
    const { db: d, calls } = db({});
    expect(await listNewAssignmentCandidates(d, since, [])).toEqual({ candidates: [], truncatedAt: null });
    expect(calls).toHaveLength(0);
  });
  it("ao atingir o limite informa até onde o cursor pode avançar", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, organization_id: "o", conversation_id: "c", created_at: `2026-10-17T12:00:${String(i % 60).padStart(2, "0")}Z`, sales_reps: { user_id: "u" }, wa_contacts: null }));
    const { db: d } = db({ lead_assignments: { data: rows } });
    expect((await listNewAssignmentCandidates(d, since, ["o"])).truncatedAt).toEqual(new Date(rows[199].created_at));
  });
});

describe("listSlaRiskCandidates", () => {
  it("calcula os minutos restantes, usa sla:{id} e exige idade mínima (não coincide com Novo lead)", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const { db: d, calls } = db({ lead_assignments: { data: [
      { id: "a1", organization_id: "o", conversation_id: "c1", sla_due_at: "2026-10-17T12:04:10Z", sales_reps: { user_id: "u1" }, wa_contacts: { name: "Ana", phone: "55" } },
    ] } });
    const r = await listSlaRiskCandidates(d, now, ["o"], 15);
    expect(r[0]).toMatchObject({ kind: "sla", userId: "u1", dedupeKeys: ["sla:a1"], title: "Responda Ana — faltam 5 min", tag: "c1" });
    has(calls, 0, "gt", "sla_due_at", now.toISOString());
    has(calls, 0, "lte", "sla_due_at", "2026-10-17T12:15:00.000Z");
    has(calls, 0, "lte", "created_at", "2026-10-17T11:55:00.000Z");
    has(calls, 0, "in", "organization_id", ["o"]);
  });
});

describe("listCustomerMessageCandidates", () => {
  const since = new Date("2026-10-17T11:59:00Z");
  const msg = (id: string, conv: string, content: string, owner: string | null, takeover: boolean, at: string) => ({
    id, content, created_at: at, conversation_id: conv, organization_id: "o",
    conversations: { assigned_to: owner, is_human_takeover: takeover, wa_contacts: { name: "Ana", phone: "55" } },
  });
  it("agrupa por conversa (última mensagem, tag = conversa), corta o trecho em 80 e filtra por papel/organização", async () => {
    const { db: d, calls } = db({ messages: { data: [
      msg("m1", "c1", "oi", "u1", true, "2026-10-17T12:00:00Z"),
      msg("m2", "c1", "x".repeat(200), "u1", true, "2026-10-17T12:00:05Z"),
    ] } });
    const { candidates } = await listCustomerMessageCandidates(d, since, ["o"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: "message", userId: "u1", dedupeKeys: ["msg:m1", "msg:m2"], tag: "c1", url: "/inbox?id=c1", title: "Ana" });
    expect(candidates[0].body).toBe("x".repeat(80));
    has(calls, 0, "eq", "role", "contact"); has(calls, 0, "in", "organization_id", ["o"]);
    has(calls, 0, "not", "conversations.assigned_to", "is", null); has(calls, 0, "gte", "created_at", since.toISOString());
  });
  it("ignora conversa sem dono; sem takeover só notifica se nunca houve resposta humana (consulta por conversa)", async () => {
    const rows = [
      msg("m1", "c1", "a", null, true, "2026-10-17T12:00:00Z"),
      msg("m2", "c2", "b", "u2", false, "2026-10-17T12:00:00Z"),
      msg("m3", "c3", "c", "u3", false, "2026-10-17T12:00:00Z"),
    ];
    const humanChecks: string[] = [];
    const humanDb = {
      from: (t: string) => {
        expect(t).toBe("messages");
        let conv = ""; let isHuman = false;
        const chain: any = new Proxy({}, { get: (_x, p: string) => {
          if (p === "then") return (res: any) => res({ error: null, data: isHuman ? (conv === "c3" ? [{ id: "h" }] : []) : rows });
          return (...a: unknown[]) => {
            if (p === "eq" && a[0] === "conversation_id") conv = String(a[1]);
            if (p === "eq" && a[0] === "role" && a[1] === "human_agent") { isHuman = true; humanChecks.push(conv); }
            return chain;
          };
        } });
        return chain;
      },
    } as any;
    const { candidates } = await listCustomerMessageCandidates(humanDb, since, ["o"]);
    expect(candidates.map(x => x.userId)).toEqual(["u2"]);
    expect(humanChecks.sort()).toEqual(["c2", "c3"]);
  });
  it("informa truncatedAt ao atingir o limite de linhas", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => msg(`m${i}`, "c1", "x", "u1", true, `2026-10-17T12:00:${String(i % 60).padStart(2, "0")}Z`));
    const { db: d } = db({ messages: { data: rows } });
    expect((await listCustomerMessageCandidates(d, since, ["o"])).truncatedAt).toEqual(new Date(rows[499].created_at));
  });
});

describe("escalada de SLA: estágio 1", () => {
  it("organizações com a chave sla_alert_escalation_enabled ligada, dentro das que têm push", async () => {
    const { db: d, calls } = db({ organizations: { data: [{ id: "o1" }] } });
    expect(await listSlaEscalationOrganizationIds(d, ["o1", "o2"])).toEqual(["o1"]);
    has(calls, 0, "in", "id", ["o1", "o2"]); has(calls, 0, "eq", "settings->>sla_alert_escalation_enabled", "true");
    expect(await listSlaEscalationOrganizationIds(d, [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("'SLA estourado: responda {nome}' ao dono, chave sla_breach:{id}, só 'alert' pendente vencido e sem primeira resposta", async () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const { db: d, calls } = db({ lead_assignments: { data: [
      { id: "a1", organization_id: "o", conversation_id: "c1", sla_due_at: "2026-10-27T10:40:00Z", sales_reps: { user_id: "marina" }, wa_contacts: { name: "Márcio", phone: "55" } },
      { id: "a2", organization_id: "o", conversation_id: "c2", sla_due_at: "2026-10-27T11:00:00Z", sales_reps: null, wa_contacts: null },
    ] } });
    const r = await listSlaBreachCandidates(d, now, ["o"]);
    expect(r).toEqual([{ kind: "sla_breach", organizationId: "o", userId: "marina", dedupeKeys: ["sla_breach:a1"], title: "SLA estourado: responda Márcio",
      body: "O prazo para responder este cliente passou. Toque para atender.", url: "/inbox?id=c1", tag: "c1" }]);
    has(calls, 0, "in", "organization_id", ["o"]); has(calls, 0, "eq", "status", "pending"); has(calls, 0, "eq", "sla_action", "alert");
    has(calls, 0, "not", "rep_id", "is", null); has(calls, 0, "is", "first_human_message_at", null);
    has(calls, 0, "lte", "sla_due_at", now.toISOString()); has(calls, 0, "gte", "sla_due_at", "2026-10-26T12:00:00.000Z");
  });

  it("sem organizações: não consulta", async () => {
    const { db: d, calls } = db({});
    expect(await listSlaBreachCandidates(d, new Date(), [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
