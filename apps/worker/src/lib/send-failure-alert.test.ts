import { describe, expect, it, vi } from "vitest";
import { BURST_THRESHOLD, buildAlertPayload, DEDUPE_BUCKET_MIN, notifySendFailure, planSendFailureAlerts, type SendFailureContext, type SendFailureDeps } from "./send-failure-alert.js";

const NOW = new Date("2026-11-16T15:00:00Z");
const ctx = (over: Partial<SendFailureContext> = {}): SendFailureContext => ({ organizationId: "org", conversationId: "conv-1", messageId: "m1", senderRole: "human_agent", contactName: "Romario", instanceName: "weslley", assigneeId: "marina", ...over });
type Over = { failures?: number; managers?: string[]; settings?: object; noPush?: string[]; claimed?: Set<string>; sendPush?: SendFailureDeps["sendPush"]; managerIds?: SendFailureDeps["managerIds"] };
function deps(over: Over = {}) {
  const { failures: _f, managers: _m, settings: _s, noPush: _n, claimed: _c, ...fnOverrides } = over;
  const sent: Array<{ userId: string; payload: any }> = []; const claimed = over.claimed ?? new Set<string>(); const released: string[] = [];
  const d: SendFailureDeps = {
    settings: async () => (over.settings ?? { send_failure_alerts_enabled: true, push_notifications_enabled: true }) as never,
    managerIds: async () => over.managers ?? ["dono"],
    countRecentFailures: async () => over.failures ?? 1,
    canReceivePush: async (_o, u) => !(over.noPush ?? []).includes(u),
    claim: async (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; },
    release: async (ks) => { ks.forEach((k) => { claimed.delete(k); released.push(k); }); },
    sendPush: async (_o, userId, payload) => { sent.push({ userId, payload }); return 1; },
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
      expect(r).toEqual({ sent: 0, skipped: ["disabled"] }); expect(x.sent).toHaveLength(0);
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
  it("deduplica por conversa e por janela de 30 min; janela seguinte avisa de novo", async () => {
    const x = deps(); await notifySendFailure(x.d, ctx(), NOW);
    expect((await notifySendFailure(x.d, ctx({ messageId: "m2" }), new Date(NOW.getTime() + 5 * 60_000))).sent).toBe(0);
    expect((await notifySendFailure(x.d, ctx({ messageId: "m3" }), new Date(NOW.getTime() + (DEDUPE_BUCKET_MIN + 1) * 60_000))).sent).toBe(1);
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
});
