import { describe, expect, it, vi } from "vitest";
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getCustomerNudgeQueue: () => ({}) }));
vi.mock("@aula-agente/database", () => ({}));
import { isCustomerRefusal, nudgePushDedupeKey, runCustomerNudge, type NudgeDeps } from "./customer-nudge.js";

// Caso Erica: simulação enviada quinta 29/10/2026 14:55 (BRT); "agora" = sexta 30/10 15:00 BRT (expediente, 1 dia útil depois).
const SENT = "2026-10-29T17:55:00Z";
const NOW = new Date("2026-10-30T18:00:00Z");

interface Conv { id?: string; contact?: string; lastRole?: string; lastAt?: string; assigned?: string | null; customerMsg?: { content: string; at: string; mediaType?: string | null } | null; tasks?: Array<{ id: string; status: string; createdAt: string; completedAt?: string | null }> }
interface Opp { id?: string; contact?: string; owner?: string | null; waitingOn?: string | null; waitingOnUntil?: string | null }

function world(o: { settings?: Record<string, unknown>; convs?: Conv[]; opps?: Opp[]; frozen?: string[]; openTasks?: any[]; openOppIds?: string[]; sellerAfter?: string[]; pushUsers?: string[]; pushSent?: number; pushThrows?: boolean; createWasUpdated?: boolean; pendencyAdded?: boolean; nonMembers?: string[]; openNudges?: any[] } = {}) {
  const convs = (o.convs ?? [{}]).map((c, i) => ({ id: c.id ?? `c${i}`, contact: c.contact ?? `ct${i}`, ...c }));
  const opps = (o.opps ?? convs.map((c): Opp => ({ contact: c.contact }))).map((p, i) => ({ id: p.id ?? `op${i}`, owner: "owner" in p ? p.owner : "seller1", waitingOn: null, waitingOnUntil: null, ...p }));
  const textCalls: string[] = []; const undone: Array<{ id: string; note: string }> = []; const created: any[] = []; const completed: Array<{ id: string; note: string }> = []; const pushes: any[] = []; const touches: any[] = []; const claimedKeys: string[] = []; const claimed = new Set<string>(); const logs: string[] = [];
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
    createTask: async (i) => { created.push(i); return { id: `task-${created.length}`, wasUpdated: o.createWasUpdated ?? false, ...(o.pendencyAdded === undefined ? {} : { pendencyAdded: o.pendencyAdded }) }; },
    recordTouch: async (_o, taskId, conversationId, touch) => { touches.push({ taskId, conversationId, touch }); },
    undoNudge: async (_o, id, note) => { undone.push({ id, note }); },
    contactName: async () => "Erica",
    listOpenNudgeTasks: async () => [...(o.openTasks ?? []), ...(o.openNudges ?? [])],
    openOpportunityIds: async (_o, ids) => new Set((o.openOppIds ?? ids).filter((x) => ids.includes(x))),
    contactsWithOpenOpportunity: async (_o, ids) => new Set(ids),
    sellerMessageAfter: async (_o, id) => (o.sellerAfter ?? []).includes(id),
    completeTask: async (_o, id, note) => { completed.push({ id, note }); },
    canReceivePush: async (_o, u) => (o.pushUsers ?? ["seller1"]).includes(u),
    claimPushDedupe: async (k) => { claimedKeys.push(k); if (claimed.has(k)) return false; claimed.add(k); return true; },
    releasePushDedupe: async (ks) => { ks.forEach((k) => claimed.delete(k)); },
    sendPush: async (_o, u, p) => { if (o.pushThrows) throw new Error("push down"); pushes.push({ u, p }); return o.pushSent ?? 1; },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
  };
  return { deps, undone, created, completed, pushes, logs, textCalls, touches, claimedKeys };
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
  it("chave de idempotência do push é por toque: nudge:<taskId>:<toque>", () => { expect(nudgePushDedupeKey("abc")).toBe("nudge:abc"); expect(nudgePushDedupeKey("abc", 2)).toBe("nudge:abc:2"); });
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

describe("runCustomerNudge: tarefas consolidadas por negócio (task_consolidation_by_opportunity_enabled)", () => {
  const CONSOLIDATED = { task_consolidation_by_opportunity_enabled: true };
  it("consolidação ligada SEM ativação explícita: nada é criado (sem disparo na implantação) e o motivo fica no log", async () => {
    const w = world({ settings: CONSOLIDATED }); const s = await runCustomerNudge(w.deps, NOW);
    expect(w.created).toHaveLength(0); expect(s.skipped.consolidation_not_activated).toBe(1);
    expect(w.logs.some((l) => l.includes("customer_nudge_consolidated_enabled"))).toBe(true);
  });
  it.each([false, "true", 1, null])("ativação só vale com true literal (%s não liga)", async (v) => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: v } }); await runCustomerNudge(w.deps, NOW);
    expect(w.created).toHaveLength(0);
  });
  it("ativada: o cutucar entra como pendência na tarefa consolidada do negócio (mesmo motor), registra o toque e avisa o dono", async () => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true }, createWasUpdated: true, pendencyAdded: true });
    const s = await runCustomerNudge(w.deps, NOW);
    expect(s.created).toBe(1); expect(s.grouped).toBe(1);
    expect(w.created[0]).toMatchObject({ ownerId: "seller1", opportunityId: "op0", dueDate: "2026-10-30" });
    expect(w.touches).toEqual([{ taskId: "task-1", conversationId: "c0", touch: 1 }]);
    expect(w.pushes).toHaveLength(1); expect(w.claimedKeys).toEqual(["nudge:task-1:1"]);
  });
  it("pendência do mesmo tipo já estava aberta (refresh): não conta como nova, não registra toque nem manda push", async () => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true }, createWasUpdated: true, pendencyAdded: false });
    const s = await runCustomerNudge(w.deps, NOW);
    expect(s.created).toBe(0); expect(s.skipped.task_already_open).toBe(1); expect(w.touches).toHaveLength(0); expect(w.pushes).toHaveLength(0);
  });
  it("pendência de cutucar já aberta dentro de uma tarefa consolidada bloqueia nova pendência (sem duplicar)", async () => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true }, openNudges: [{ id: "tx", conversationId: "c0", contactId: "ct0", opportunityId: "op0", createdAt: "2026-10-30T12:00:00Z" }] });
    const s = await runCustomerNudge(w.deps, NOW);
    expect(w.created).toHaveLength(0); expect(s.skipped.open_task).toBe(1);
  });
  it("falha ao registrar o toque é contada como erro e logada, sem derrubar a execução", async () => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true } });
    w.deps.recordTouch = async () => { throw new Error("db down"); };
    const s = await runCustomerNudge(w.deps, NOW);
    expect(s.created).toBe(1); expect(s.errors).toBe(1); expect(w.logs.some((l) => l.includes("touch not recorded"))).toBe(true);
  });
  it("pendência agrupada + toque que falha nas 2 tentativas: desfaz a pendência, não conta como criada e não envia push", async () => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true, push_notifications_enabled: true }, createWasUpdated: true, pendencyAdded: true });
    let calls = 0; w.deps.recordTouch = async () => { calls++; throw new Error("db down"); };
    const s = await runCustomerNudge(w.deps, NOW);
    expect(calls).toBe(2); expect(w.undone).toHaveLength(1); expect(s.created).toBe(0); expect(s.grouped).toBe(0); expect(w.pushes).toHaveLength(0);
    expect(s.skipped.touch_not_recorded_undone).toBe(1);
  });
  it("falha transitória do toque (2ª tentativa funciona): conta normalmente, sem desfazer", async () => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true }, createWasUpdated: true, pendencyAdded: true });
    let calls = 0; const orig = w.deps.recordTouch; w.deps.recordTouch = async (...a) => { if (++calls === 1) throw new Error("blip"); return orig(...a); };
    const s = await runCustomerNudge(w.deps, NOW);
    expect(s.created).toBe(1); expect(s.errors).toBe(0); expect(w.undone).toHaveLength(0); expect(w.touches).toHaveLength(1);
  });
  it("se o desfazer também falha: erro alto no log (pendência sem toque), sem derrubar a execução", async () => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true }, createWasUpdated: true, pendencyAdded: true });
    w.deps.recordTouch = async () => { throw new Error("down"); }; w.deps.undoNudge = async () => { throw new Error("down2"); };
    const s = await runCustomerNudge(w.deps, NOW);
    expect(s.created).toBe(0); expect(s.errors).toBe(2); expect(w.logs.some((l) => l.includes("UNDO FAILED"))).toBe(true);
  });
  it("negócio aguardando equipe, administradora ou data combinada continua bloqueado mesmo com consolidação ativa", async () => {
    for (const [waitingOn, waitingOnUntil, reason] of [["team", null, "waiting_on_us"], ["bank_or_admin", null, "waiting_on_us"], ["scheduled_date", "2026-11-20", "waiting_scheduled"]] as const) {
      const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true }, opps: [{ contact: "ct0", waitingOn, waitingOnUntil }] });
      const s = await runCustomerNudge(w.deps, NOW);
      expect(w.created, waitingOn).toHaveLength(0); expect(s.skipped[reason], waitingOn).toBe(1);
    }
  });
  it("aguardando o cliente (waiting_on=customer) é cutucado", async () => {
    const w = world({ settings: { ...CONSOLIDATED, customer_nudge_consolidated_enabled: true }, opps: [{ contact: "ct0", waitingOn: "customer" }] });
    expect((await runCustomerNudge(w.deps, NOW)).created).toBe(1);
  });
});

describe("runCustomerNudge: ativação gradual (linha de corte e teto)", () => {
  it("mensagem do vendedor anterior à linha de corte é histórico: não cobra (sem disparo retroativo)", async () => {
    const w = world({ settings: { customer_nudge_baseline_at: "2026-10-30T00:00:00Z" } }); const s = await runCustomerNudge(w.deps, NOW);
    expect(w.created).toHaveLength(0); expect(s.skipped.before_baseline).toBe(1);
  });
  it("mensagem a partir da linha de corte é cobrada normalmente", async () => {
    const w = world({ settings: { customer_nudge_baseline_at: "2026-10-29T00:00:00Z" } });
    expect((await runCustomerNudge(w.deps, NOW)).created).toBe(1);
  });
  it("linha de corte inválida é ignorada (regra normal)", async () => {
    const w = world({ settings: { customer_nudge_baseline_at: "ontem" } });
    expect((await runCustomerNudge(w.deps, NOW)).created).toBe(1);
  });
  it("customer_nudge_max_new_per_run reduz o teto por execução; valores inválidos voltam a 25", async () => {
    const convs = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, contact: `ct${i}`, lastAt: `2026-10-29T17:${String(10 + i).padStart(2, "0")}:00Z` }));
    const at = new Date("2026-10-30T20:00:00Z");
    const a = world({ convs, settings: { customer_nudge_max_new_per_run: 3 } }); expect((await runCustomerNudge(a.deps, at)).created).toBe(3);
    const b = world({ convs, settings: { customer_nudge_max_new_per_run: 0 } }); expect((await runCustomerNudge(b.deps, at)).created).toBe(25);
    const c = world({ convs, settings: { customer_nudge_max_new_per_run: "7" } }); expect((await runCustomerNudge(c.deps, at)).created).toBe(25);
  });
});

describe("runCustomerNudge: transferência entre vendedores e retomada", () => {
  it("negócio transferido: a pendência vai para o dono ATUAL do negócio (não o antigo responsável da conversa) e o push também", async () => {
    const w = world({ convs: [{ assigned: "seller1" }], opps: [{ contact: "ct0", owner: "seller2" }], pushUsers: ["seller1", "seller2"] });
    await runCustomerNudge(w.deps, NOW);
    expect(w.created[0].ownerId).toBe("seller2"); expect(w.pushes[0].u).toBe("seller2");
  });
  it("sem dono no negócio usa o responsável da conversa; sem nenhum dos dois não cria", async () => {
    const a = world({ convs: [{ assigned: "seller3" }], opps: [{ contact: "ct0", owner: null }], pushUsers: ["seller3"] });
    await runCustomerNudge(a.deps, NOW); expect(a.created[0].ownerId).toBe("seller3");
    const b = world({ convs: [{ assigned: null }], opps: [{ contact: "ct0", owner: null }] });
    const s = await runCustomerNudge(b.deps, NOW); expect(b.created).toHaveLength(0); expect(s.skipped.no_owner).toBe(1);
  });
  it("retomada: cliente respondeu depois do toque 1 => o ciclo recomeça no toque 1; os toques do ciclo antigo não contam", async () => {
    const oldTouch = { id: "t0#0", status: "completed", createdAt: "2026-10-20T12:00:00Z" };
    const w = world({ convs: [{ tasks: [oldTouch], customerMsg: { content: "voltei, quero fechar", at: "2026-10-25T12:00:00Z" } }] });
    await runCustomerNudge(w.deps, NOW);
    expect(w.created[0].description).toContain("toque 1 de 3"); expect(w.touches[0].touch).toBe(1);
  });
  it("toque registrado como evento (tarefa consolidada) conta para o toque seguinte", async () => {
    const w = world({ convs: [{ tasks: [{ id: "tk#0", status: "completed", createdAt: "2026-10-30T18:00:00Z" }], lastAt: "2026-10-30T18:00:00Z" }] });
    await runCustomerNudge(w.deps, new Date("2026-11-05T18:00:00Z"));
    expect(w.created[0].description).toContain("toque 2 de 3");
  });
});

describe("runCustomerNudge: observabilidade", () => {
  it("resumo informa negócios vistos, conversas avaliadas, criadas, agrupadas e bloqueios por motivo; o log carrega os mesmos números", async () => {
    const convs = [{ id: "c0", contact: "ct0" }, { id: "c1", contact: "ct1", lastRole: "contact" }, { id: "c2", contact: "ct2" }];
    const opps = [{ contact: "ct0" }, { contact: "ct1" }, { contact: "ct2", waitingOn: "team" }];
    const w = world({ convs, opps }); const s = await runCustomerNudge(w.deps, NOW);
    expect(s).toMatchObject({ organizations: 1, opportunities: 3, evaluated: 3, created: 1, grouped: 0, errors: 0 });
    expect(s.skipped).toEqual({ not_seller_last: 1, waiting_on_us: 1 });
    const line = w.logs.find((l) => l.startsWith("customer-nudge: orgs="))!;
    expect(line).toContain("opps=3"); expect(line).toContain("evaluated=3"); expect(line).toContain("created=1"); expect(line).toContain("grouped=0");
    expect(line).toContain('"waiting_on_us":1');
  });
});
