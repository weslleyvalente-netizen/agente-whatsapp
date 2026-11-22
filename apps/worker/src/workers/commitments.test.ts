import { describe, expect, it, vi } from "vitest";
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getCommitmentsQueue: () => ({}) }));
vi.mock("@aula-agente/database", () => ({}));
import { runCommitments, type CommitmentsDeps, type SellerMessage, type ConvMessage } from "./commitments.js";

// 23/11/2026 é segunda. Calendário padrão seg–sex 08:00–18:00 (BRT = UTC-3).
const brt = (s: string) => `${new Date(`${s}-03:00`).toISOString()}`;
const PROPOSTA = "Ficou assim: R$ 80.000, entrada de 10 mil e parcelas de 1.200";

interface WorldOpts {
  settings?: Record<string, unknown>;
  seller?: Array<Partial<SellerMessage> & { content: string }>;
  after?: Record<string, Array<Partial<ConvMessage> & { role: string; createdAt: string }>>;
  stageEventAt?: string | null;
  oppStatus?: string;
  oppOwner?: string | null;
  pendencyGone?: string[];
}

const camel = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));

function world(o: WorldOpts = {}) {
  const proposals: any[] = []; const commitments: any[] = []; const tasks: any[] = []; const resolved: Array<{ taskId: string; type: string; note: string }> = []; const logs: string[] = [];
  const seller: SellerMessage[] = (o.seller ?? []).map((m, i) => ({
    id: m.id ?? `m${i}`, conversationId: m.conversationId ?? "c1", contactId: m.contactId ?? "ct1", assignedTo: m.assignedTo ?? null,
    createdAt: m.createdAt ?? brt("2026-11-23T10:00:00"), waOriginalAt: m.waOriginalAt ?? null, content: m.content, mediaType: m.mediaType ?? "text",
    fileName: m.fileName ?? null, sendFailed: m.sendFailed ?? false,
  }));
  const deps: CommitmentsDeps = {
    listOrganizations: async () => [{ id: "org1", settings: { commitments_enabled: true, ...(o.settings ?? {}) } }],
    listSellerMessages: async () => seller,
    messagesAfter: async (_org, conv, afterIso) => (o.after?.[conv] ?? []).filter((m) => m.createdAt > afterIso)
      .map((m, i) => ({ id: m.id ?? `a${i}`, role: m.role, createdAt: m.createdAt, content: m.content ?? "", mediaType: m.mediaType ?? "text", fileName: m.fileName ?? null })),
    openOpportunity: async () => (o.oppStatus && o.oppStatus !== "open" ? null : { id: "op1", ownerId: o.oppOwner === undefined ? "marina" : o.oppOwner }),
    opportunityStatuses: async (_org, ids) => new Map(ids.map((i) => [i, o.oppStatus ?? "open"])),
    proposalStageEventSince: async (_org, _opp, since) => (o.stageEventAt && o.stageEventAt >= since ? { at: o.stageEventAt, stage: "proposal_sent" } : null),
    insertProposal: async (row) => { if (proposals.some((p) => p.sellerMessageId === row.sellerMessageId)) return false; proposals.push({ id: `p${proposals.length}`, reminderTaskId: null, firstSellerFollowupAt: null, firstCustomerReplyAt: null, outcome: null, ...row }); return true; },
    listTrackedProposals: async () => proposals.map((p) => ({ ...p })),
    updateProposal: async (_org, id, patch) => { Object.assign(proposals.find((p) => p.id === id), camel(patch)); },
    insertCommitment: async (row) => { if (commitments.some((c) => c.sellerMessageId === row.sellerMessageId)) return null; const id = `k${commitments.length}`; commitments.push({ id, taskId: null, resolvedAt: null, resolution: null, ...row }); return id; },
    supersedeCommitments: async (_org, conv, keep, at) => { for (const c of commitments) if (c.conversationId === conv && c.id !== keep && !c.resolvedAt) Object.assign(c, { resolvedAt: at, resolution: "superseded" }); },
    listOpenCommitments: async () => commitments.filter((c) => !c.resolvedAt).map((c) => ({ ...c })),
    updateCommitment: async (_org, id, patch) => { Object.assign(commitments.find((c) => c.id === id), camel(patch)); },
    createTask: async (i) => { const existing = tasks.find((t) => t.type === i.type && t.opportunityId === i.opportunityId && !t.done); if (existing) { Object.assign(existing, i); return { id: existing.id }; } const t = { id: `t${tasks.length}`, ...i }; tasks.push(t); return { id: t.id }; },
    taskHasOpenPendency: async (_org, taskId) => !(o.pendencyGone ?? []).includes(taskId) && !tasks.find((t) => t.id === taskId)?.done,
    resolvePendency: async (_org, taskId, type, note) => { resolved.push({ taskId, type, note }); const t = tasks.find((x) => x.id === taskId); if (t) t.done = true; },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
  };
  return { deps, proposals, commitments, tasks, resolved, logs, seller };
}

describe("proposta enviada → lembrete interno de 30 min", () => {
  it("proposta com valor + termo: registra e, 30 min úteis depois sem resposta, cria a tarefa interna (nada é enviado ao cliente)", async () => {
    const w = world({ seller: [{ content: PROPOSTA }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    expect(w.proposals).toHaveLength(1);
    expect(w.proposals[0]).toMatchObject({ identifiedBy: "content", ownerUserId: "marina", sentAt: brt("2026-11-23T10:00:00") });
    expect(w.proposals[0].evidence).toMatch(/valor/);
    expect(w.tasks).toHaveLength(1);
    expect(w.tasks[0]).toMatchObject({ type: "proposal_followup", ownerId: "marina", opportunityId: "op1", dueDate: "2026-11-23" });
    expect(w.tasks[0].description).toContain("Proposta enviada há 30 min — avaliar próximo contato");
    expect(w.proposals[0].reminderTaskId).toBe("t0");
    expect(Object.keys(w.deps).some((k) => /send|push|message.*send/i.test(k))).toBe(false);
  });
  it("antes dos 30 min: registra a proposta, mas sem tarefa", async () => {
    const w = world({ seller: [{ content: PROPOSTA }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:20:00")));
    expect(w.proposals).toHaveLength(1);
    expect(w.tasks).toHaveLength(0);
  });
  it("imagem sozinha não é proposta: sem registro e sem lembrete de 30 min", async () => {
    const w = world({ seller: [{ content: "", mediaType: "image" }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T11:00:00")));
    expect(w.proposals).toHaveLength(0);
    expect(w.tasks).toHaveLength(0);
  });
  it("evento explícito de etapa (Proposta enviada) identifica a proposta e grava o motivo", async () => {
    const w = world({ seller: [{ content: "segue o que conversamos" }], stageEventAt: brt("2026-11-23T09:50:00") });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    expect(w.proposals[0]).toMatchObject({ identifiedBy: "stage_event" });
    expect(w.proposals[0].evidence).toMatch(/Etapa movida para Proposta enviada às 09:50/);
  });
  it("evento de etapa muito antes da mensagem (mais de 2 h) não conta", async () => {
    const w = world({ seller: [{ content: "bom dia" }], stageEventAt: brt("2026-11-23T07:00:00") });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    expect(w.proposals).toHaveLength(0);
  });
  it("duas execuções seguidas (5 min) não duplicam registro nem tarefa", async () => {
    const w = world({ seller: [{ content: PROPOSTA }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:36:00")));
    expect(w.proposals).toHaveLength(1);
    expect(w.tasks).toHaveLength(1);
  });
  it("cliente respondeu antes dos 30 min: sem lembrete e a resposta entra na métrica", async () => {
    const w = world({ seller: [{ content: PROPOSTA }], after: { c1: [{ role: "contact", createdAt: brt("2026-11-23T10:15:00"), content: "vou ver com minha esposa" }] } });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    expect(w.tasks).toHaveLength(0);
    expect(w.proposals[0].firstCustomerReplyAt).toBe(brt("2026-11-23T10:15:00"));
  });
  it("vendedor já voltou a falar antes dos 30 min: sem lembrete e o acompanhamento entra na métrica", async () => {
    const w = world({ seller: [{ content: PROPOSTA }], after: { c1: [{ role: "human_agent", createdAt: brt("2026-11-23T10:20:00"), content: "conseguiu ver?" }] } });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    expect(w.tasks).toHaveLength(0);
    expect(w.proposals[0].firstSellerFollowupAt).toBe(brt("2026-11-23T10:20:00"));
  });
  it("lembrete aberto é encerrado quando o cliente responde (a escada zera)", async () => {
    const w = world({ seller: [{ content: PROPOSTA }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    w.deps.messagesAfter = async () => [{ id: "r1", role: "contact", createdAt: brt("2026-11-23T10:40:00"), content: "gostei", mediaType: "text", fileName: null }];
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:41:00")));
    expect(w.resolved).toEqual([expect.objectContaining({ taskId: "t0", type: "proposal_followup" })]);
  });
  it("proposta às 17:50: o lembrete só nasce às 08:20 do dia seguinte", async () => {
    const w = world({ seller: [{ content: PROPOSTA, createdAt: brt("2026-11-23T17:50:00") }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T18:30:00")));
    expect(w.tasks).toHaveLength(0);
    await runCommitments(w.deps, new Date(brt("2026-11-24T08:21:00")));
    expect(w.tasks).toHaveLength(1);
  });
  it("feriado (holiday_set=posse_go): proposta no dia útil anterior só lembra no próximo dia útil", async () => {
    // 19/10/2026 (segunda) é feriado municipal de Posse. Proposta sexta 16/10 17:50.
    const w = world({ settings: { business_calendar: { timeZone: "America/Sao_Paulo", weekly: { mon: [{ start: "08:00", end: "18:00" }], tue: [{ start: "08:00", end: "18:00" }], wed: [{ start: "08:00", end: "18:00" }], thu: [{ start: "08:00", end: "18:00" }], fri: [{ start: "08:00", end: "18:00" }] }, holiday_set: "posse_go" } }, seller: [{ content: PROPOSTA, createdAt: brt("2026-10-16T17:50:00") }] });
    await runCommitments(w.deps, new Date(brt("2026-10-16T17:55:00"))); // a rotina roda a cada 5 min: registra na sexta
    await runCommitments(w.deps, new Date(brt("2026-10-19T09:00:00")));
    expect(w.tasks).toHaveLength(0);
    await runCommitments(w.deps, new Date(brt("2026-10-20T08:21:00")));
    expect(w.tasks).toHaveLength(1);
  });
  it("negócio ganho: a métrica registra o resultado e não cria lembrete", async () => {
    const w = world({ seller: [{ content: PROPOSTA }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:20:00")));
    w.deps.opportunityStatuses = async (_o, ids) => new Map(ids.map((i) => [i, "won"]));
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    expect(w.proposals[0].outcome).toBe("won");
    expect(w.tasks).toHaveLength(0);
  });
});

describe("mensagem antiga que chega atrasada", () => {
  it("horário original do WhatsApp com mais de 24 h: não gera proposta nem promessa", async () => {
    const w = world({ seller: [{ content: `${PROPOSTA}. Vou verificar e te retorno`, createdAt: brt("2026-11-23T10:00:00"), waOriginalAt: brt("2026-11-20T10:00:00") }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T11:00:00")));
    expect(w.proposals).toHaveLength(0);
    expect(w.commitments).toHaveLength(0);
    expect(w.tasks).toHaveLength(0);
  });
  it("mensagem com falha de envio não conta", async () => {
    const w = world({ seller: [{ content: PROPOSTA, sendFailed: true }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T11:00:00")));
    expect(w.proposals).toHaveLength(0);
  });
});

describe("promessa do vendedor → pendência interna com prazo", () => {
  it("'vou verificar e te retorno' cria 'Retornar ao cliente' com prazo de 2 h úteis", async () => {
    const w = world({ seller: [{ content: "Vou verificar a condição e te retorno" }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:05:00")));
    expect(w.commitments).toHaveLength(1);
    expect(w.commitments[0]).toMatchObject({ kind: "standard", dueAt: brt("2026-11-23T12:00:00"), ownerUserId: "marina" });
    expect(w.tasks[0]).toMatchObject({ type: "return_customer", dueDate: "2026-11-23", dueTime: "12:00", ownerId: "marina" });
    expect(w.tasks[0].description).toContain("Retornar ao cliente");
  });
  it("prazo ajustável (promise_default_minutes)", async () => {
    const w = world({ settings: { promise_default_minutes: 60 }, seller: [{ content: "vou consultar" }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:05:00")));
    expect(w.commitments[0].dueAt).toBe(brt("2026-11-23T11:00:00"));
  });
  it("mensagem genérica posterior do vendedor NÃO encerra a promessa", async () => {
    const w = world({ seller: [{ content: "vou verificar" }], after: { c1: [{ role: "human_agent", createdAt: brt("2026-11-23T10:30:00"), content: "ok" }] } });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:05:00")));
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:35:00")));
    expect(w.commitments[0].resolvedAt).toBeNull();
    expect(w.resolved).toHaveLength(0);
  });
  it("vendedor entregou (mensagem posterior com evidência comercial forte): promessa cumprida", async () => {
    const w = world({ seller: [{ content: "vou verificar" }], after: { c1: [{ role: "human_agent", createdAt: brt("2026-11-23T11:00:00"), content: PROPOSTA }] } });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:05:00")));
    await runCommitments(w.deps, new Date(brt("2026-11-23T11:05:00")));
    expect(w.commitments[0]).toMatchObject({ resolution: "delivered" });
    expect(w.resolved).toEqual([expect.objectContaining({ taskId: "t0", type: "return_customer" })]);
  });
  it("vendedor concluiu a tarefa no CRM: promessa resolvida", async () => {
    const w = world({ seller: [{ content: "vou verificar" }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:05:00")));
    w.tasks[0].done = true;
    await runCommitments(w.deps, new Date(brt("2026-11-23T13:00:00")));
    expect(w.commitments[0]).toMatchObject({ resolution: "task_completed" });
  });
  it("negócio fechado: promessa encerrada", async () => {
    const w = world({ seller: [{ content: "vou verificar" }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:05:00")));
    w.deps.opportunityStatuses = async (_o, ids) => new Map(ids.map((i) => [i, "lost"]));
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:10:00")));
    expect(w.commitments[0]).toMatchObject({ resolution: "opportunity_closed" });
  });
  it("nova promessa na mesma conversa substitui a anterior (prazo atualizado, sem duplicar tarefa)", async () => {
    const w = world({ seller: [{ id: "m1", content: "já te falo", createdAt: brt("2026-11-23T10:00:00") }, { id: "m2", content: "te retorno às 15h", createdAt: brt("2026-11-23T10:20:00") }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:25:00")));
    expect(w.commitments.find((c) => c.sellerMessageId === "m1").resolution).toBe("superseded");
    expect(w.commitments.find((c) => c.sellerMessageId === "m2")).toMatchObject({ kind: "explicit_time", dueAt: brt("2026-11-23T15:00:00"), resolvedAt: null });
    expect(w.tasks).toHaveLength(1);
    expect(w.tasks[0].dueTime).toBe("15:00");
  });
  it("duas execuções não duplicam a promessa", async () => {
    const w = world({ seller: [{ content: "vou verificar" }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:05:00")));
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:10:00")));
    expect(w.commitments).toHaveLength(1);
    expect(w.tasks).toHaveLength(1);
  });
});

describe("reabertura e dono", () => {
  it("conversa reaberta (outra conversa do mesmo contato): a tarefa vai para o dono do negócio", async () => {
    const w = world({ seller: [{ content: "vou verificar", conversationId: "c2-reaberta", assignedTo: null }], oppOwner: "marcio" });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:05:00")));
    expect(w.tasks[0]).toMatchObject({ ownerId: "marcio", opportunityId: "op1", conversationId: "c2-reaberta" });
  });
  it("sem negócio com dono, usa o vendedor da conversa; sem nenhum, não cria tarefa", async () => {
    const a = world({ seller: [{ content: "vou verificar", assignedTo: "marina" }], oppOwner: null });
    await runCommitments(a.deps, new Date(brt("2026-11-23T10:05:00")));
    expect(a.tasks[0].ownerId).toBe("marina");
    const b = world({ seller: [{ content: "vou verificar" }], oppOwner: null });
    await runCommitments(b.deps, new Date(brt("2026-11-23T10:05:00")));
    expect(b.tasks).toHaveLength(0);
  });
  it("flag desligada: não faz nada", async () => {
    const w = world({ settings: { commitments_enabled: false }, seller: [{ content: PROPOSTA }] });
    await runCommitments(w.deps, new Date(brt("2026-11-23T10:31:00")));
    expect(w.proposals).toHaveLength(0);
  });
});
