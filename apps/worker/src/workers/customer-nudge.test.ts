import { describe, expect, it, vi } from "vitest";
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getCustomerNudgeQueue: () => ({}) }));
vi.mock("@aula-agente/database", () => ({}));
import { isCustomerRefusal, nudgePushDedupeKey, runCustomerNudge, type NudgeDeps } from "./customer-nudge.js";

// Caso Erica: simulação enviada quinta 29/10/2026 14:55 (BRT); "agora" = sexta 30/10 15:00 BRT (expediente, 1 dia útil depois).
const SENT = "2026-10-29T17:55:00Z";
const NOW = new Date("2026-10-30T18:00:00Z");

interface Conv { id?: string; contact?: string; lastRole?: string; lastAt?: string; assigned?: string | null; customerMsg?: { content: string; at: string; mediaType?: string | null } | null; tasks?: Array<{ id: string; status: string; createdAt: string }> }
interface Opp { id?: string; contact?: string; owner?: string | null; waitingOn?: string | null; waitingOnUntil?: string | null }

function world(o: { settings?: Record<string, unknown>; convs?: Conv[]; opps?: Opp[]; frozen?: string[]; openTasks?: any[]; openOppIds?: string[]; sellerAfter?: string[]; pushUsers?: string[]; pushSent?: number; pushThrows?: boolean; createWasUpdated?: boolean } = {}) {
  const convs = (o.convs ?? [{}]).map((c, i) => ({ id: c.id ?? `c${i}`, contact: c.contact ?? `ct${i}`, ...c }));
  const opps = (o.opps ?? convs.map((c): Opp => ({ contact: c.contact }))).map((p, i) => ({ id: p.id ?? `op${i}`, owner: "owner" in p ? p.owner : "seller1", waitingOn: null, waitingOnUntil: null, ...p }));
  const created: any[] = []; const completed: Array<{ id: string; note: string }> = []; const pushes: any[] = []; const claimed = new Set<string>(); const logs: string[] = [];
  const settings = { customer_nudge_enabled: true, push_notifications_enabled: true, ...(o.settings ?? {}) };
  const deps: NudgeDeps = {
    listOrganizations: async () => [{ id: "org1", settings }],
    listOpenOpportunities: async () => opps.map((p) => ({ id: p.id, contactId: p.contact!, ownerId: p.owner ?? null, waitingOn: p.waitingOn ?? null, waitingOnUntil: p.waitingOnUntil ?? null, lastInteractionAt: null })),
    listConversations: async () => convs.map((c) => ({ id: c.id, contactId: c.contact, assignedTo: c.assigned ?? null, lastMessageAt: c.lastAt ?? SENT })),
    lastMessage: async (id) => { const c = convs.find((x) => x.id === id)!; return { id: `m-${id}`, role: c.lastRole ?? "human_agent", content: "Segue a simulação", mediaType: null, createdAt: c.lastAt ?? SENT }; },
    lastCustomerMessage: async (id) => { const m = convs.find((x) => x.id === id)!.customerMsg; return m === undefined ? { id: "cm", role: "contact", content: "Quero uma simulação de imóvel", mediaType: null, createdAt: "2026-10-29T17:00:00Z" } : m ? { id: "cm", role: "contact", content: m.content, mediaType: m.mediaType ?? null, createdAt: m.at } : null; },
    nudgeTasks: async (_o, id) => convs.find((x) => x.id === id)!.tasks ?? [],
    isFrozen: async (_o, contactId) => (o.frozen ?? []).includes(contactId),
    createTask: async (i) => { created.push(i); return { id: `task-${created.length}`, wasUpdated: o.createWasUpdated ?? false }; },
    contactName: async () => "Erica",
    listOpenNudgeTasks: async () => o.openTasks ?? [],
    openOpportunityIds: async (_o, ids) => new Set((o.openOppIds ?? ids).filter((x) => ids.includes(x))),
    contactsWithOpenOpportunity: async (_o, ids) => new Set(ids),
    sellerMessageAfter: async (id) => (o.sellerAfter ?? []).includes(id),
    completeTask: async (_o, id, note) => { completed.push({ id, note }); },
    canReceivePush: async (_o, u) => (o.pushUsers ?? ["seller1"]).includes(u),
    claimPushDedupe: async (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; },
    releasePushDedupe: async (ks) => { ks.forEach((k) => claimed.delete(k)); },
    sendPush: async (_o, u, p) => { if (o.pushThrows) throw new Error("push down"); pushes.push({ u, p }); return o.pushSent ?? 1; },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
  };
  return { deps, created, completed, pushes, logs };
}

describe("runCustomerNudge: criação", () => {
  it("caso Erica: vendedora falou por último há 1 dia útil => tarefa toque 1 para o dono, due_date hoje, com push", async () => {
    const w = world();
    const s = await runCustomerNudge(w.deps, NOW);
    expect(s.created).toBe(1);
    expect(w.created[0]).toMatchObject({
      organizationId: "org1", conversationId: "c0", opportunityId: "op0", ownerId: "seller1", priority: "normal", dueDate: "2026-10-30",
      description: "Cliente parou de responder há 1 dia útil depois da sua última mensagem. Retome a conversa (toque 1 de 3).",
    });
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]).toMatchObject({ u: "seller1", p: { title: "Cutucar cliente", url: "/inbox?id=c0" } });
    expect(w.pushes[0].p.body).toContain("Erica");
  });
  it("ainda não deu 1 dia útil: não cria", async () => {
    const w = world();
    const s = await runCustomerNudge(w.deps, new Date("2026-10-30T14:00:00Z")); // sex 11:00
    expect(s.created).toBe(0); expect(s.skipped.not_due_yet).toBe(1);
  });
  it("toque 2 conta só as tarefas depois da última mensagem do cliente; tarefas antigas (cliente falou depois) não contam", async () => {
    const at = new Date("2026-11-03T17:55:00Z"); // ter 14:55 = 3 dias úteis
    const old = { id: "t0", status: "completed", createdAt: "2026-10-20T12:00:00Z" };
    const mine = { id: "t1", status: "completed", createdAt: "2026-10-30T18:00:00Z" };
    const w2 = world({ convs: [{ tasks: [old, mine] }] });
    await runCustomerNudge(w2.deps, at);
    expect(w2.created[0].description).toContain("toque 2 de 3");
    const w3 = world({ convs: [{ tasks: [old] }] }); // a antiga é de antes da fala do cliente => toque 1
    await runCustomerNudge(w3.deps, at);
    expect(w3.created[0].description).toContain("toque 1 de 3");
  });
  it("toque 3 tem prioridade alta; depois dele para", async () => {
    const t = (n: number) => ({ id: `t${n}`, status: "completed", createdAt: `2026-10-3${n}T18:00:00Z` });
    const w = world({ convs: [{ tasks: [t(0), t(1)], lastAt: "2026-10-30T18:00:00Z" }] });
    await runCustomerNudge(w.deps, new Date("2026-11-11T14:00:00Z")); // ter 11/11 (7 dias úteis desde sex 30/10 15:00)
    expect(w.created[0]).toMatchObject({ priority: "high" });
    expect(w.created[0].description).toContain("considere encerrar ou marcar o negócio como perdido");
    const w4 = world({ convs: [{ tasks: [t(0), t(1), { id: "t2", status: "completed", createdAt: "2026-11-02T18:00:00Z" }], lastAt: "2026-10-30T18:00:00Z" }] });
    await runCustomerNudge(w4.deps, new Date("2026-11-12T14:00:00Z"));
    expect(w4.created).toHaveLength(0)
  });
  it("cliente que nunca falou: conta todas as tarefas", async () => {
    const w = world({ convs: [{ customerMsg: null, tasks: [{ id: "t0", status: "completed", createdAt: "2026-10-20T12:00:00Z" }], lastAt: "2026-10-30T18:00:00Z" }] });
    await runCustomerNudge(w.deps, new Date("2026-11-04T18:00:00Z"));
    expect(w.created[0].description).toContain("toque 2 de 3");
  });
});

describe("runCustomerNudge: quando não cria", () => {
  const skipped = async (over: Parameters<typeof world>[0], reason: string, now = NOW) => {
    const w = world(over); const s = await runCustomerNudge(w.deps, now);
    expect(w.created).toHaveLength(0); expect(s.skipped[reason]).toBe(1); return w;
  };
  it("mensagem da IA (agent) ou do cliente por último", async () => {
    await skipped({ convs: [{ lastRole: "agent" }] }, "not_seller_last");
    await skipped({ convs: [{ lastRole: "contact" }] }, "not_seller_last");
  });
  it("sem dono: sem owner_id e sem assigned_to; com assigned_to usa o fallback", async () => {
    await skipped({ opps: [{ contact: "ct0", owner: null }] }, "no_owner");
    const w = world({ opps: [{ contact: "ct0", owner: null }], convs: [{ assigned: "seller9" }], pushUsers: ["seller9"] });
    await runCustomerNudge(w.deps, NOW);
    expect(w.created[0].ownerId).toBe("seller9");
  });
  it("fora do expediente", async () => { await skipped({}, "outside_business_hours", new Date("2026-10-30T23:00:00Z")); });
  it("contato congelado", async () => { await skipped({ frozen: ["ct0"] }, "frozen"); });
  it("retorno combinado no futuro, pendência nossa", async () => {
    await skipped({ opps: [{ contact: "ct0", waitingOn: "scheduled_date", waitingOnUntil: "2026-11-10" }] }, "waiting_scheduled");
    await skipped({ opps: [{ contact: "ct0", waitingOn: "team" }] }, "waiting_on_us");
    await skipped({ opps: [{ contact: "ct0", waitingOn: "bank_or_admin" }] }, "waiting_on_us");
  });
  it("cliente se despediu, agradeceu ou recusou antes", async () => {
    await skipped({ convs: [{ customerMsg: { content: "ok, obrigado!", at: "2026-10-29T17:00:00Z" } }] }, "closing_ack");
    await skipped({ convs: [{ customerMsg: { content: "Não tenho mais interesse", at: "2026-10-29T17:00:00Z" } }] }, "closing_ack");
  });
  it("já existe tarefa de cutucar aberta", async () => {
    await skipped({ convs: [{ tasks: [{ id: "t", status: "pending", createdAt: "2026-10-30T12:00:00Z" }] }] }, "open_task");
  });
  it("mais de 14 dias desde a mensagem do vendedor", async () => {
    await skipped({ convs: [{ lastAt: "2026-10-10T17:55:00Z" }] }, "too_old");
  });
  it("flag desligada: nada acontece", async () => {
    const w = world({ settings: { customer_nudge_enabled: false } }); const s = await runCustomerNudge(w.deps, NOW);
    expect(s.organizations).toBe(0); expect(w.created).toHaveLength(0);
  });
  it("tarefa já existente atualizada pelo dedup não conta como nova nem manda push", async () => {
    const w = world({ createWasUpdated: true }); const s = await runCustomerNudge(w.deps, NOW);
    expect(s.created).toBe(0); expect(w.pushes).toHaveLength(0);
  });
});

describe("runCustomerNudge: anti-enxurrada e push", () => {
  it("no máximo 25 tarefas por organização, as mais recentes primeiro", async () => {
    const convs = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, contact: `ct${i}`, lastAt: `2026-10-29T17:${String(10 + i).padStart(2, "0")}:00Z` }));
    const w = world({ convs });
    // lastMessage usa lastAt; todas já com 1+ dia útil
    const s = await runCustomerNudge(w.deps, new Date("2026-10-30T20:00:00Z"));
    expect(s.created).toBe(25);
    expect(w.created[0].conversationId).toBe("c29");
    expect(w.created.map((c) => c.conversationId)).not.toContain("c0");
  });
  it("push desligado na organização ou sem assinatura: cria a tarefa sem push", async () => {
    const a = world({ settings: { push_notifications_enabled: false } }); await runCustomerNudge(a.deps, NOW);
    expect(a.created).toHaveLength(1); expect(a.pushes).toHaveLength(0);
    const b = world({ pushUsers: [] }); await runCustomerNudge(b.deps, NOW);
    expect(b.created).toHaveLength(1); expect(b.pushes).toHaveLength(0);
  });
  it("falha de push nunca derruba a execução nem a tarefa", async () => {
    const w = world({ pushThrows: true }); const s = await runCustomerNudge(w.deps, NOW);
    expect(s.created).toBe(1); expect(s.errors).toBe(0); expect(s.pushed).toBe(0);
    expect(w.logs.some((l) => l.includes("push failed"))).toBe(true);
  });
  it("chave de idempotência do push é nudge:<taskId>", () => expect(nudgePushDedupeKey("abc")).toBe("nudge:abc"));
});

describe("runCustomerNudge: resolução automática", () => {
  const open = (o: Partial<any> = {}) => ({ id: "t1", conversationId: "c0", contactId: "ct0", opportunityId: "op0", createdAt: "2026-10-30T18:00:00Z", ...o });
  it("conclui com nota quando o vendedor já cutucou depois da tarefa", async () => {
    const w = world({ openTasks: [open()], sellerAfter: ["c0"], convs: [{ lastRole: "agent" }] });
    const s = await runCustomerNudge(w.deps, NOW);
    expect(s.resolved).toBe(1); expect(w.completed[0].note).toContain("Vendedor já cutucou");
  });
  it("conclui com nota quando o negócio deixou de estar aberto", async () => {
    const w = world({ openTasks: [open()], openOppIds: [], convs: [{ lastRole: "agent" }] });
    await runCustomerNudge(w.deps, NOW);
    expect(w.completed[0].note).toContain("deixou de estar aberto");
  });
  it("mantém a tarefa quando nada mudou", async () => {
    const w = world({ openTasks: [open()], convs: [{ lastRole: "agent" }] });
    await runCustomerNudge(w.deps, NOW);
    expect(w.completed).toHaveLength(0);
  });
  it("resolve mesmo fora do expediente", async () => {
    const w = world({ openTasks: [open()], sellerAfter: ["c0"] });
    await runCustomerNudge(w.deps, new Date("2026-10-31T15:00:00Z"));
    expect(w.completed).toHaveLength(1);
  });
});

describe("isCustomerRefusal", () => {
  it("pega recusa curta e deixa passar pergunta/mensagem normal", () => {
    expect(isCustomerRefusal("Não tenho interesse, obrigado")).toBe(true);
    expect(isCustomerRefusal("desisti")).toBe(true);
    expect(isCustomerRefusal("Quero uma simulação de imóvel")).toBe(false);
    expect(isCustomerRefusal("Não sei qual escolher, pode me explicar a diferença entre os planos e as parcelas que vocês oferecem?")).toBe(false);
  });
});
