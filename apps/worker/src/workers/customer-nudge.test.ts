import { describe, expect, it, vi } from "vitest";
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getCustomerNudgeQueue: () => ({}) }));
vi.mock("@aula-agente/database", () => ({}));
import { isCustomerRefusal, nudgePushDedupeKey, runCustomerNudge, type NudgeDeps } from "./customer-nudge.js";

// Caso Erica: simulação enviada quinta 29/10/2026 14:55 (BRT); "agora" = sexta 30/10 15:00 BRT (expediente, 1 dia útil depois).
const SENT = "2026-10-29T17:55:00Z";
const NOW = new Date("2026-10-30T18:00:00Z");

interface Conv { id?: string; contact?: string; lastRole?: string; lastAt?: string; assigned?: string | null; customerMsg?: { content: string; at: string; mediaType?: string | null } | null; tasks?: Array<{ id: string; status: string; createdAt: string; completedAt?: string | null }> }
interface Opp { id?: string; contact?: string; owner?: string | null; waitingOn?: string | null; waitingOnUntil?: string | null }

function world(o: { settings?: Record<string, unknown>; convs?: Conv[]; opps?: Opp[]; frozen?: string[]; openTasks?: any[]; openOppIds?: string[]; sellerAfter?: string[]; pushUsers?: string[]; pushSent?: number; pushThrows?: boolean; createWasUpdated?: boolean; nonMembers?: string[]; openNudges?: any[] } = {}) {
  const convs = (o.convs ?? [{}]).map((c, i) => ({ id: c.id ?? `c${i}`, contact: c.contact ?? `ct${i}`, ...c }));
  const opps = (o.opps ?? convs.map((c): Opp => ({ contact: c.contact }))).map((p, i) => ({ id: p.id ?? `op${i}`, owner: "owner" in p ? p.owner : "seller1", waitingOn: null, waitingOnUntil: null, ...p }));
  const textCalls: string[] = []; const created: any[] = []; const completed: Array<{ id: string; note: string }> = []; const pushes: any[] = []; const claimed = new Set<string>(); const logs: string[] = [];
  const settings = { customer_nudge_enabled: true, push_notifications_enabled: true, ...(o.settings ?? {}) };
  const deps: NudgeDeps = {
    listOrganizations: async () => [{ id: "org1", settings }],
    listOpenOpportunities: async () => opps.map((p) => ({ id: p.id, contactId: p.contact!, ownerId: p.owner ?? null, waitingOn: p.waitingOn ?? null, waitingOnUntil: p.waitingOnUntil ?? null, lastInteractionAt: null })),
    listConversations: async () => convs.map((c) => ({ id: c.id, contactId: c.contact, assignedTo: c.assigned ?? null, lastMessageAt: c.lastAt ?? SENT })),
    lastMessage: async (_o, id) => { const c = convs.find((x) => x.id === id)!; return { role: c.lastRole ?? "human_agent", createdAt: c.lastAt ?? SENT }; },
    lastCustomerMessage: async (_o, id) => { const m = convs.find((x) => x.id === id)!.customerMsg; return m === undefined ? { id: `cm-${id}`, role: "contact", mediaType: null, createdAt: "2026-10-29T17:00:00Z" } : m ? { id: `cm-${id}`, role: "contact", mediaType: m.mediaType ?? null, createdAt: m.at } : null; },
    messageText: async (_o, mid) => { textCalls.push(mid); const id = mid.replace("cm-", ""); return convs.find((x) => x.id === id)!.customerMsg?.content ?? "Quero uma simulação de imóvel"; },
    isMember: async (_o, u) => !(o.nonMembers ?? []).includes(u),
    nudgeTasks: async (_o, id) => (convs.find((x) => x.id === id)!.tasks ?? []).map((t) => ({ completedAt: null, ...t })),
    isFrozen: async (_o, contactId) => (o.frozen ?? []).includes(contactId),
    createTask: async (i) => { created.push(i); return { id: `task-${created.length}`, wasUpdated: o.createWasUpdated ?? false }; },
    contactName: async () => "Erica",
    listOpenNudgeTasks: async () => [...(o.openTasks ?? []), ...(o.openNudges ?? [])],
    openOpportunityIds: async (_o, ids) => new Set((o.openOppIds ?? ids).filter((x) => ids.includes(x))),
    contactsWithOpenOpportunity: async (_o, ids) => new Set(ids),
    sellerMessageAfter: async (_o, id) => (o.sellerAfter ?? []).includes(id),
    completeTask: async (_o, id, note) => { completed.push({ id, note }); },
    canReceivePush: async (_o, u) => (o.pushUsers ?? ["seller1"]).includes(u),
    claimPushDedupe: async (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; },
    releasePushDedupe: async (ks) => { ks.forEach((k) => claimed.delete(k)); },
    sendPush: async (_o, u, p) => { if (o.pushThrows) throw new Error("push down"); pushes.push({ u, p }); return o.pushSent ?? 1; },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
  };
  return { deps, created, completed, pushes, logs, textCalls };
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
    expect(w.pushes[0]).toMatchObject({ u: "seller1", p: { title: "Cutucar cliente", url: "/opportunities?conversa=c0" } });
    expect(w.pushes[0].p.body).toContain("Erica");
  });
  it("ainda não deu 1 dia útil: não cria", async () => {
    const w = world();
    const s = await runCustomerNudge(w.deps, new Date("2026-10-30T14:00:00Z")); // sex 11:00
    expect(s.created).toBe(0); expect(s.skipped.not_due_yet).toBe(1);
  });
  it("toque 2 conta só as tarefas depois da última mensagem do cliente; tarefas antigas (cliente falou depois) não contam", async () => {
    const at = new Date("2026-11-05T18:00:00Z"); // qui 15:00: passou o silêncio de 3 dias úteis e o intervalo de 2 dias úteis desde o toque 1
    const old = { id: "t0", status: "completed", createdAt: "2026-10-20T12:00:00Z" };
    const mine = { id: "t1", status: "completed", createdAt: "2026-10-30T18:00:00Z" };
    const w2 = world({ convs: [{ tasks: [old, mine] }] });
    await runCustomerNudge(w2.deps, at);
    expect(w2.created[0].description).toContain("toque 2 de 3");
    const w3 = world({ convs: [{ tasks: [old] }] }); // a antiga é de antes da fala do cliente => toque 1
    await runCustomerNudge(w3.deps, at);
    expect(w3.created[0].description).toContain("toque 1 de 3");
  });
  it("toque 2 NÃO nasce logo depois de o vendedor concluir o toque 1, mesmo com silêncio > 3 dias úteis; nasce 2 dias úteis depois", async () => {
    const tasks = [{ id: "t1", status: "completed", createdAt: "2026-11-03T11:09:00Z", completedAt: "2026-11-03T11:20:00Z" }]; // ter 08:09 criada, 08:20 concluída
    const conv = { tasks, lastAt: "2026-10-27T12:00:00Z", customerMsg: { content: "oi", at: "2026-10-27T11:00:00Z" } };
    const w = world({ convs: [conv] });
    const s = await runCustomerNudge(w.deps, new Date("2026-11-03T11:40:00Z")); // 30 min depois
    expect(w.created).toHaveLength(0); expect(s.skipped.nudge_interval).toBe(1);
    const w2 = world({ convs: [conv] });
    await runCustomerNudge(w2.deps, new Date("2026-11-04T20:00:00Z")); // quarta 17:00: só 1 dia útil desde a conclusão
    expect(w2.created).toHaveLength(0);
    const w3 = world({ convs: [conv] });
    await runCustomerNudge(w3.deps, new Date("2026-11-05T11:30:00Z")); // quinta 08:30: 2 dias úteis completos desde ter 08:20
    expect(w3.created[0].description).toContain("toque 2 de 3");
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
  it("cliente recusou explicitamente antes", async () => {
    await skipped({ convs: [{ customerMsg: { content: "Não tenho mais interesse", at: "2026-10-29T17:00:00Z" } }] }, "customer_refused");
  });
  it("ok/obrigado do cliente seguido de mensagem do vendedor e silêncio É cutucado (caso Erica)", async () => {
    for (const content of ["ok, obrigado!", "Obrigada", "ok", "beleza, vou ver"]) {
      const w = world({ convs: [{ customerMsg: { content, at: "2026-10-29T17:00:00Z" } }] });
      await runCustomerNudge(w.deps, NOW);
      expect(w.created, content).toHaveLength(1);
    }
  });
  it("o texto da última mensagem do cliente só é lido quando a tarefa sairia", async () => {
    const w = world({ frozen: ["ct0"] }); await runCustomerNudge(w.deps, NOW);
    expect(w.textCalls).toHaveLength(0);
  });
  it("organização com consolidação por negócio ligada: não cria e registra o motivo", async () => {
    const w = world({ settings: { task_consolidation_by_opportunity_enabled: true } }); const s = await runCustomerNudge(w.deps, NOW);
    expect(w.created).toHaveLength(0); expect(s.skipped.consolidation_enabled).toBe(1);
    expect(w.logs.some((l) => l.includes("task_consolidation_by_opportunity_enabled"))).toBe(true);
  });
  it("dono que saiu da organização conta como sem dono", async () => {
    await skipped({ nonMembers: ["seller1"] }, "no_owner");
  });
  it("já existe cutucar aberto no mesmo negócio (outra conversa) ou no mesmo contato sem negócio", async () => {
    await skipped({ openNudges: [{ id: "tx", conversationId: "outra", contactId: "ctX", opportunityId: "op0", createdAt: "2026-10-30T12:00:00Z" }] }, "open_task");
    await skipped({ openNudges: [{ id: "ty", conversationId: "outra", contactId: "ct0", opportunityId: null, createdAt: "2026-10-30T12:00:00Z" }] }, "open_task");
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
  it("pega recusas em frases fechadas", () => {
    for (const t of ["Sem interesse", "Não tenho interesse, obrigado", "não tenho mais interesse", "desisti", "Já comprei", "já fechei", "já resolvi", "Não quero mais", "não vou mais comprar", "Pode encerrar", "pode cancelar"]) expect(isCustomerRefusal(t), t).toBe(true);
  });
  it("não pega frases comuns que começam parecido", () => {
    for (const t of ["Não tem problema", "Não tenho o RG aqui", "Não vou conseguir hoje", "não quero parcela alta", "ok", "Obrigado", "Quero uma simulação de imóvel", "Não sei qual escolher"]) expect(isCustomerRefusal(t), t).toBe(false);
  });
});
