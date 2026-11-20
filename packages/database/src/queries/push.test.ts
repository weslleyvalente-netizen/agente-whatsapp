import { describe, expect, it, vi } from "vitest";
import {
  claimPushDedupe, deletePushSubscription, listCustomerMessageCandidates, listNewAssignmentCandidates,
  listSlaRiskCandidates, upsertPushSubscription, releasePushDedupe, purgePushNotificationLog,
  listPushEnabledOrganizationIds, listCurrentMemberIds, listSlaBreachCandidates, listSlaEscalationOrganizationIds,
  listExceptionCandidates, listExceptionPushOrganizationIds,
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
      { kind: "assign", organizationId: "o", userId: "u1", dedupeKeys: ["assign:a1"], title: "Novo lead: Ana", body: "Toque para atender.", url: "/opportunities?conversa=c1", tag: "c1" },
      { kind: "assign", organizationId: "o", userId: "u2", dedupeKeys: ["assign:a2"], title: "Novo lead: Cliente", body: "Toque para atender.", url: "/opportunities?conversa=c2", tag: "c2" },
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
    expect(candidates[0]).toMatchObject({ kind: "message", userId: "u1", dedupeKeys: ["msg:m1", "msg:m2"], tag: "c1", url: "/opportunities?conversa=c1", title: "Ana" });
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
  it("conversa nova de cliente que voltou (vendedor herdado, nasce em takeover) já gera o aviso ao vendedor — sem tarefa/evento extra", async () => {
    // Forma que ensureConversation cria até 24 h após atendimento humano. (Depois de 24 h a conversa nasce sem takeover e sem
    // resposta humana: já coberto pelo teste acima, "sem takeover só notifica se nunca houve resposta humana".)
    const rows = [msg("m1", "c-takeover", "Ok maravilha", "u-vendedor", true, "2026-10-17T12:00:00Z")];
    const { db: d } = db({ messages: { data: rows } });
    const { candidates } = await listCustomerMessageCandidates(d, since, ["o"]);
    expect(candidates.map((c) => [c.userId, c.tag, c.dedupeKeys])).toEqual([
      ["u-vendedor", "c-takeover", ["msg:m1"]],
    ]);
    expect(candidates[0]).toMatchObject({ title: "Ana", url: "/opportunities?conversa=c-takeover" });
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
      body: "O prazo para responder este cliente passou. Toque para atender.", url: "/opportunities?conversa=c1", tag: "c1" }]);
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

describe("aviso ao gestor: conversa em exceção", () => {
  const now = new Date("2026-11-19T15:00:00Z");
  const exc = (id: string, over: Record<string, unknown> = {}) => ({
    id, organization_id: "o", conversation_id: `conv-${id}`, handoff_at: "2026-11-19T13:30:00Z", exception_reason: "all_reps_sla_breached",
    previous_assignment_id: `prev-${id}`, wa_contacts: { name: "Claudivan", phone: "556296148561" }, ...over,
  });
  // Uma resposta por tabela e por chamada, na ordem: lead_assignments (exceções), lead_assignments (anteriores), organization_members (gestores).
  const queued = (...results: Array<{ data?: unknown }>) => {
    const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
    let i = 0;
    const from = (table: string) => {
      const entry = { table, ops: [] as Array<[string, unknown[]]> }; calls.push(entry);
      const r = results[i++] ?? { data: [] };
      const c: any = new Proxy({}, { get: (_t, prop: string) => prop === "then" ? (res: any) => res({ data: r.data ?? null, error: null }) : (...args: unknown[]) => { entry.ops.push([prop, args]); return c; } });
      return c;
    };
    return { db: { from } as any, calls };
  };

  it("organizações com a chave exception_manager_push_enabled === true", async () => {
    const { db: d, calls } = queued({ data: [{ id: "o1" }] });
    expect(await listExceptionPushOrganizationIds(d, ["o1", "o2"])).toEqual(["o1"]);
    has(calls, 0, "in", "id", ["o1", "o2"]); has(calls, 0, "eq", "settings->>exception_manager_push_enabled", "true");
    expect(await listExceptionPushOrganizationIds(d, [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("um aviso por gestor (owner/admin) com cliente, último responsável, tempo de espera e link da conversa; chave por entrada e por gestor", async () => {
    const { db: d, calls } = queued(
      { data: [exc("e1")] },
      { data: [{ id: "prev-e1", sales_reps: { display_name: "Marina" } }] },
      { data: [{ user_id: "dono" }, { user_id: "gestor" }] },
    );
    const r = await listExceptionCandidates(d, now, ["o"]);
    expect(r).toEqual([
      { kind: "exception", organizationId: "o", userId: "dono", dedupeKeys: ["exception:e1:dono"], title: "Cliente sem dono: Claudivan",
        body: "Nenhum vendedor respondeu no prazo. Último responsável: Marina. Aguardando há 1 h. Toque para atribuir.", url: "/opportunities?conversa=conv-e1", tag: "exception-conv-e1" },
      { kind: "exception", organizationId: "o", userId: "gestor", dedupeKeys: ["exception:e1:gestor"], title: "Cliente sem dono: Claudivan",
        body: "Nenhum vendedor respondeu no prazo. Último responsável: Marina. Aguardando há 1 h. Toque para atribuir.", url: "/opportunities?conversa=conv-e1", tag: "exception-conv-e1" },
    ]);
    // só exceções abertas e recentes, só das organizações habilitadas; gestores = owner/admin
    has(calls, 0, "in", "organization_id", ["o"]); has(calls, 0, "eq", "status", "exception"); has(calls, 0, "is", "resolved_at", null);
    has(calls, 0, "gte", "created_at", "2026-11-18T15:00:00.000Z");
    has(calls, 2, "in", "role", ["owner", "admin"]);
  });

  it("sem responsável anterior: 'nenhum'; motivo desconhecido cai no texto genérico; cada exceção gera a sua chave", async () => {
    const { db: d } = queued(
      { data: [exc("e2", { previous_assignment_id: null, exception_reason: "no_available_rep" }), exc("e3", { previous_assignment_id: null, exception_reason: null })] },
      { data: [{ user_id: "dono" }] },
    );
    const r = await listExceptionCandidates(d, now, ["o"]);
    expect(r.map((c) => c.dedupeKeys[0])).toEqual(["exception:e2:dono", "exception:e3:dono"]);
    expect(r[0].body).toContain("Nenhum vendedor disponível. Último responsável: nenhum.");
    expect(r[1].body).toContain("Sem vendedor responsável. Último responsável: nenhum.");
  });

  it("sem organizações ou sem exceções: não avisa", async () => {
    const none = queued({ data: [] });
    expect(await listExceptionCandidates(none.db, now, ["o"])).toEqual([]);
    expect(none.calls).toHaveLength(1);
    const off = queued();
    expect(await listExceptionCandidates(off.db, now, [])).toEqual([]);
    expect(off.calls).toHaveLength(0);
  });
});
