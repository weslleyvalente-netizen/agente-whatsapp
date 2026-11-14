import { describe, expect, it, vi } from "vitest";
import { BURST_THRESHOLD, buildAlertPayload, buildTaskText, CONVERSATION_BUCKET_MIN, MAX_ALERT_AGE_MIN, notifySendFailure, planSendFailureAlerts, type SendFailureContext, type SendFailureDeps } from "./send-failure-alert.js";

const NOW = new Date("2026-11-16T15:00:00Z");
const ctx = (over: Partial<SendFailureContext> = {}): SendFailureContext => ({ organizationId: "org", conversationId: "conv-1", contactId: "ct-1", messageId: "m1", messageCreatedAt: new Date(NOW.getTime() - 60_000).toISOString(), senderRole: "human_agent", contactName: "Romario", instanceName: "weslley", assigneeId: "marina", ...over });
type Over = { failures?: number; managers?: string[]; settings?: object; noPush?: string[]; claimed?: Set<string>; tasks?: Array<{ ctx: SendFailureContext; text: { description: string; reason: string } }>; createTask?: SendFailureDeps["createTask"]; sendPush?: SendFailureDeps["sendPush"]; managerIds?: SendFailureDeps["managerIds"] };
function deps(over: Over = {}) {
  const { failures: _f, managers: _m, settings: _s, noPush: _n, claimed: _c, tasks: _t, ...fnOverrides } = over;
  const sent: Array<{ userId: string; payload: any }> = []; const claimed = over.claimed ?? new Set<string>(); const released: string[] = [];
  const d: SendFailureDeps = {
    settings: async () => (over.settings ?? { send_failure_alerts_enabled: true, push_notifications_enabled: true }) as never,
    managerIds: async () => over.managers ?? ["dono"],
    countRecentFailures: async () => over.failures ?? 1,
    canReceivePush: async (_o, u) => !(over.noPush ?? []).includes(u),
    claim: async (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; },
    release: async (ks) => { ks.forEach((k) => { claimed.delete(k); released.push(k); }); },
    sendPush: async (_o, userId, payload) => { sent.push({ userId, payload }); return 1; },
    createTask: async (c, text) => { (over.tasks ?? []).push({ ctx: c, text }); },
    log: { error: vi.fn() }, ...fnOverrides,
  };
  return { d, sent, claimed, released };
}

describe("planSendFailureAlerts", () => {
  it("com responsável: avisa o vendedor; sem rajada, gestores não", () => {
    expect(planSendFailureAlerts({ assigneeId: "marina", managerIds: ["dono"], burstCount: 1 })).toEqual([{ userId: "marina", kind: "seller" }]);
  });
  it("sem responsável: os gestores recebem o aviso da conversa (alguém precisa ver)", () => {
    expect(planSendFailureAlerts({ assigneeId: null, managerIds: ["dono", "adm"], burstCount: 1 })).toEqual([{ userId: "dono", kind: "manager_conversation" }, { userId: "adm", kind: "manager_conversation" }]);
  });
  it(`rajada (≥ ${BURST_THRESHOLD} falhas em poucos minutos): gestores recebem o aviso agregado além do vendedor`, () => {
    expect(planSendFailureAlerts({ assigneeId: "marina", managerIds: ["dono"], burstCount: BURST_THRESHOLD })).toEqual([{ userId: "marina", kind: "seller" }, { userId: "dono", kind: "manager_burst" }]);
    expect(planSendFailureAlerts({ assigneeId: "marina", managerIds: ["dono"], burstCount: BURST_THRESHOLD - 1 })).toEqual([{ userId: "marina", kind: "seller" }]);
  });
  it("gestor que é o próprio responsável não recebe duas vezes", () => {
    expect(planSendFailureAlerts({ assigneeId: "dono", managerIds: ["dono"], burstCount: 10 })).toEqual([{ userId: "dono", kind: "seller" }]);
  });
});

describe("notifySendFailure", () => {
  it("desligado por padrão: sem a chave (ou sem push ligado) nada é enviado nem consultado além das configurações", async () => {
    for (const settings of [{}, { send_failure_alerts_enabled: true }, { push_notifications_enabled: true }, { send_failure_alerts_enabled: "true", push_notifications_enabled: true }]) {
      const x = deps({ settings }); const r = await notifySendFailure(x.d, ctx(), NOW);
      expect(r).toEqual({ sent: 0, tasks: 0, skipped: ["disabled"] }); expect(x.sent).toHaveLength(0);
    }
  });
  it("vendedor responsável recebe o push da conversa (link para a conversa; sem texto da mensagem nem telefone)", async () => {
    const x = deps(); const r = await notifySendFailure(x.d, ctx(), NOW);
    expect(r.sent).toBe(1); expect(x.sent).toHaveLength(1);
    expect(x.sent[0].userId).toBe("marina");
    expect(x.sent[0].payload).toMatchObject({ title: "Mensagem não enviada", url: expect.stringContaining("conv-1"), tag: "send-failed-conv-1" });
    expect(x.sent[0].payload.body).toContain("Sua mensagem para Romario"); expect(x.sent[0].payload.body).toContain("weslley");
    expect(JSON.stringify(x.sent)).not.toMatch(/\d{8,}/);
  });
  it("resposta automática da MarIAna tem texto próprio; contato sem nome vira 'um cliente' (nunca expõe o identificador)", async () => {
    const x = deps(); await notifySendFailure(x.d, ctx({ senderRole: "agent", contactName: "185796074164331" }), NOW);
    expect(x.sent[0].payload.body).toContain("A resposta automática para um cliente"); expect(x.sent[0].payload.body).not.toContain("1857960");
  });
  it(`deduplica por conversa na janela de ${CONVERSATION_BUCKET_MIN} min; falha posterior depois da janela avisa de novo`, async () => {
    const x = deps(); await notifySendFailure(x.d, ctx(), NOW);
    expect((await notifySendFailure(x.d, ctx({ messageId: "m2" }), new Date(NOW.getTime() + 2 * 60_000))).sent).toBe(0);
    expect((await notifySendFailure(x.d, ctx({ messageId: "m3" }), new Date(NOW.getTime() + (CONVERSATION_BUCKET_MIN + 1) * 60_000))).sent).toBe(1);
    expect((await notifySendFailure(x.d, ctx({ conversationId: "conv-2" }), NOW)).sent).toBe(1); // outra conversa
  });
  it("rajada: gestor recebe UM aviso agregado por janela (instância e contagem), com link para as configurações", async () => {
    const x = deps({ failures: 4 });
    const r = await notifySendFailure(x.d, ctx(), NOW);
    expect(r.sent).toBe(2);
    const burst = x.sent.find((s) => s.userId === "dono")!;
    expect(burst.payload).toMatchObject({ title: "Mensagens não enviadas", url: "/settings" }); expect(burst.payload.body).toContain("4 mensagens"); expect(burst.payload.body).toContain("weslley");
    expect((await notifySendFailure(x.d, ctx({ conversationId: "conv-9" }), NOW)).sent).toBe(1); // o agregado não repete; o vendedor da outra conversa sim
  });
  it("rajada que PIORA (a cada 5 falhas a mais) avisa o gestor de novo dentro da mesma janela", async () => {
    const claimed = new Set<string>();
    const a = deps({ failures: 3, claimed }); await notifySendFailure(a.d, ctx(), NOW);
    const b = deps({ failures: 9, claimed }); const r = await notifySendFailure(b.d, ctx({ conversationId: "conv-7" }), NOW);
    expect(b.sent.some((x) => x.userId === "dono")).toBe(true); expect(r.sent).toBe(2);
  });
  it("usuário sem push ativo é pulado sem erro; push que não entrega libera a chave para tentar de novo", async () => {
    const a = deps({ noPush: ["marina"] }); expect((await notifySendFailure(a.d, ctx(), NOW)).skipped).toEqual(["no_push:seller"]);
    const b = deps({ sendPush: async () => 0 }); const r = await notifySendFailure(b.d, ctx(), NOW);
    expect(r.sent).toBe(0); expect(r.skipped).toEqual(["not_delivered:seller"]); expect(b.released).toHaveLength(1);
  });
  it("NUNCA lança: falha de banco ou de push vira log sem telefone, e libera a chave", async () => {
    const a = deps({ managerIds: async () => { throw new Error("db 5562996188374 down"); } });
    const r = await notifySendFailure(a.d, ctx(), NOW); expect(r.skipped).toContain("error");
    expect(String((a.d.log.error as any).mock.calls[0][0])).not.toContain("5562996188374");
    const b = deps({ sendPush: async () => { throw new Error("push down"); } });
    expect((await notifySendFailure(b.d, ctx(), NOW)).skipped).toEqual(["error:seller"]); expect(b.released).toHaveLength(1);
  });
  it("buildAlertPayload: texto fixo, sem conteúdo da mensagem", () => {
    expect(buildAlertPayload("seller", ctx(), 1).body).not.toMatch(/entrada|R\$|parcela/);
  });

  it("NUNCA alerta mensagem antiga (reprocessamento de fila ou backlog depois de uma queda)", async () => {
    const x = deps({ settings: { send_failure_alerts_enabled: true, push_notifications_enabled: true, send_failure_tasks_enabled: true }, tasks: [] });
    const old = new Date(NOW.getTime() - (MAX_ALERT_AGE_MIN + 1) * 60_000).toISOString();
    expect(await notifySendFailure(x.d, ctx({ messageCreatedAt: old }), NOW)).toEqual({ sent: 0, tasks: 0, skipped: ["too_old"] });
    expect(x.sent).toHaveLength(0);
    const fresh = new Date(NOW.getTime() - (MAX_ALERT_AGE_MIN - 1) * 60_000).toISOString();
    expect((await notifySendFailure(x.d, ctx({ messageCreatedAt: fresh }), NOW)).sent).toBe(1);
  });
});

describe("tarefa persistente (não depende de push)", () => {
  const tasksOnly = { send_failure_tasks_enabled: true };
  it("só com a chave de tarefas: cria a tarefa e não envia push", async () => {
    const tasks: any[] = []; const x = deps({ settings: tasksOnly, tasks });
    expect(await notifySendFailure(x.d, ctx(), NOW)).toEqual({ sent: 0, tasks: 1, skipped: [] });
    expect(tasks).toHaveLength(1); expect(tasks[0].ctx.assigneeId).toBe("marina"); expect(tasks[0].text.description).toContain("NÃO foi entregue"); expect(x.sent).toHaveLength(0);
  });
  it("destinatário SEM push (o dono hoje) continua coberto pela tarefa; o push dele é só pulado", async () => {
    const tasks: any[] = []; const x = deps({ settings: { ...tasksOnly, send_failure_alerts_enabled: true, push_notifications_enabled: true }, tasks, noPush: ["marina", "dono"] });
    const r = await notifySendFailure(x.d, ctx({ assigneeId: null }), NOW);
    expect(r.tasks).toBe(1); expect(r.sent).toBe(0); expect(r.skipped).toEqual(["no_push:manager_conversation"]);
  });
  it("sem responsável a tarefa vai sem assignee (fila dos gestores); texto sem conteúdo da mensagem nem telefone", async () => {
    const tasks: any[] = []; const x = deps({ settings: tasksOnly, tasks });
    await notifySendFailure(x.d, ctx({ assigneeId: null, contactName: "185796074164331" }), NOW);
    expect(tasks[0].ctx.assigneeId).toBeNull(); expect(tasks[0].text.description).toContain("um cliente"); expect(JSON.stringify(tasks[0].text)).not.toMatch(/\d{8,}/);
    expect(buildTaskText(ctx({ senderRole: "agent" })).description).toContain("A resposta automática");
  });
  it("falha ao criar a tarefa não impede o push, e é registrada sem telefone", async () => {
    const x = deps({ settings: { ...tasksOnly, send_failure_alerts_enabled: true, push_notifications_enabled: true }, createTask: async () => { throw new Error("db 5562996188374 down"); } });
    const r = await notifySendFailure(x.d, ctx(), NOW);
    expect(r.sent).toBe(1); expect(r.tasks).toBe(0); expect(r.skipped).toContain("error:task");
    expect(String((x.d.log.error as any).mock.calls[0][0])).not.toContain("5562996188374");
  });
});
