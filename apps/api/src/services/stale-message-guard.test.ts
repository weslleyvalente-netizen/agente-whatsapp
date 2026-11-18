import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyStaleMessageGuard, type StaleGuardDeps } from "./stale-message-guard.js";

const NOW = new Date("2026-11-18T19:00:00.000Z");
const sec = (minAgo: number) => Math.floor(NOW.getTime() / 1000) - minAgo * 60;
const noop = () => undefined;

function mk(settings: Record<string, unknown> | null, over: Partial<StaleGuardDeps> = {}) {
  const deps = {
    readSettings: vi.fn(async () => settings),
    answeredAfter: vi.fn(async () => false),
    stampMessage: vi.fn(async () => undefined),
    startTakeover: vi.fn(async () => undefined),
    notify: vi.fn(async () => 1),
    log: { info: vi.fn(noop), error: vi.fn(noop) },
    ...over,
  };
  return deps as typeof deps & StaleGuardDeps;
}
const input = (over: Record<string, unknown> = {}) => ({
  organizationId: "org-1", conversation: { id: "conv-1", is_human_takeover: false, assigned_to: "seller-1" }, messageId: "msg-1",
  messageTimestamp: sec(180), isReplay: false, now: NOW, ...over,
});

let d: ReturnType<typeof mk>;
beforeEach(() => { d = mk({ stale_message_guard_mode: "on" }); });

describe("tráfego normal não paga leitura", () => {
  it("mensagem recente: segue sem ler configuração", async () => {
    const r = await applyStaleMessageGuard(d, input({ messageTimestamp: sec(1) }));
    expect(r).toMatchObject({ action: "proceed", reason: "fresh" });
    expect(d.readSettings).not.toHaveBeenCalled();
  });
  it("sem timestamp: segue como hoje, sem ler configuração", async () => {
    for (const ts of [undefined, null, 0]) expect(await applyStaleMessageGuard(d, input({ messageTimestamp: ts }))).toMatchObject({ action: "proceed", reason: "no_timestamp" });
    expect(d.readSettings).not.toHaveBeenCalled();
    expect(d.startTakeover).not.toHaveBeenCalled();
  });
  it("timestamp muito no futuro (relógio errado): segue, não retém", async () => {
    const r = await applyStaleMessageGuard(d, input({ messageTimestamp: sec(-60) }));
    expect(r).toMatchObject({ action: "proceed", reason: "future_clock_skew" });
    expect(d.readSettings).not.toHaveBeenCalled();
  });
  it("mensagem da recuperação interna (replay) nunca é retida", async () => {
    const r = await applyStaleMessageGuard(d, input({ isReplay: true }));
    expect(r.action).toBe("proceed");
    expect(d.readSettings).not.toHaveBeenCalled();
  });
});

describe("modo off", () => {
  it.each([[null], [{}], [{ stale_message_guard_mode: "off" }], [{ stale_message_guard_mode: "ligado" }]])("settings %j: não toca em nada", async (s) => {
    d = mk(s as never);
    const r = await applyStaleMessageGuard(d, input());
    expect(r).toMatchObject({ action: "proceed", reason: "off" });
    expect(d.stampMessage).not.toHaveBeenCalled();
    expect(d.startTakeover).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
});

describe("modo shadow", () => {
  it("só registra o que faria; a IA segue respondendo como hoje", async () => {
    d = mk({ stale_message_guard_mode: "shadow" });
    const r = await applyStaleMessageGuard(d, input());
    expect(r).toMatchObject({ action: "proceed", reason: "stale_shadow", ageMinutes: 180 });
    expect(d.stampMessage).toHaveBeenCalledWith("msg-1", { stale_guard: expect.objectContaining({ mode: "shadow", would: "hold_and_human", age_minutes: 180, already_answered: false }) });
    expect(d.startTakeover).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
  it("já respondida: registra would=skip_ai", async () => {
    d = mk({ stale_message_guard_mode: "shadow" }, { answeredAfter: vi.fn(async () => true) });
    await applyStaleMessageGuard(d, input());
    expect(d.stampMessage).toHaveBeenCalledWith("msg-1", { stale_guard: expect.objectContaining({ would: "skip_ai", already_answered: true }) });
  });
  it("falha ao registrar a sombra nunca impede o atendimento", async () => {
    d = mk({ stale_message_guard_mode: "shadow" }, { stampMessage: vi.fn(async () => { throw new Error("db"); }) });
    expect((await applyStaleMessageGuard(d, input())).action).toBe("proceed");
  });
});

describe("modo on", () => {
  it("mensagem atrasada: retém da IA, passa para humano e avisa o responsável", async () => {
    const r = await applyStaleMessageGuard(d, input());
    expect(r).toMatchObject({ action: "hold", reason: "stale_held", ageMinutes: 180 });
    expect(d.startTakeover).toHaveBeenCalledWith("conv-1", NOW.toISOString());
    expect(d.notify).toHaveBeenCalledWith("org-1", "seller-1", expect.objectContaining({ tag: "stale-guard-conv-1" }));
    expect(d.stampMessage).toHaveBeenCalledWith("msg-1", { stale_guard: expect.objectContaining({ mode: "on", action: "hold_and_human", original_at: new Date(sec(180) * 1000).toISOString() }) });
  });
  it("contato SEM vendedor: takeover e aviso aos gestores (alvo null); não grava dono", async () => {
    const r = await applyStaleMessageGuard(d, input({ conversation: { id: "conv-2", is_human_takeover: false, assigned_to: null } }));
    expect(r.action).toBe("hold");
    expect(d.startTakeover).toHaveBeenCalledWith("conv-2", expect.any(String));
    expect(d.notify).toHaveBeenCalledWith("org-1", null, expect.any(Object));
    expect(Object.keys(d)).not.toContain("assignOwner");
  });
  it("conversa já em takeover: não repete o takeover", async () => {
    await applyStaleMessageGuard(d, input({ conversation: { id: "conv-1", is_human_takeover: true, assigned_to: "seller-1" } }));
    expect(d.startTakeover).not.toHaveBeenCalled();
  });
  it("já respondida depois do horário original: IA não responde, sem takeover nem aviso", async () => {
    d = mk({ stale_message_guard_mode: "on" }, { answeredAfter: vi.fn(async () => true) });
    const r = await applyStaleMessageGuard(d, input());
    expect(r).toMatchObject({ action: "hold", reason: "stale_already_answered" });
    expect(d.answeredAfter).toHaveBeenCalledWith("conv-1", new Date(sec(180) * 1000).toISOString());
    expect(d.startTakeover).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
  it("falha ao checar resposta: trata como não respondida e vai para humano", async () => {
    d = mk({ stale_message_guard_mode: "on" }, { answeredAfter: vi.fn(async () => { throw new Error("db"); }) });
    const r = await applyStaleMessageGuard(d, input());
    expect(r).toMatchObject({ action: "hold", reason: "stale_held" });
    expect(d.startTakeover).toHaveBeenCalled();
  });
  it("falha no takeover ou no aviso não desfaz a retenção (a mensagem continua gravada e fora da IA)", async () => {
    d = mk({ stale_message_guard_mode: "on" }, { startTakeover: vi.fn(async () => { throw new Error("db"); }), notify: vi.fn(async () => { throw new Error("push"); }) });
    expect((await applyStaleMessageGuard(d, input())).action).toBe("hold");
  });
  it("limite configurável: 90 min deixa passar mensagem de 60 min e retém a de 120", async () => {
    d = mk({ stale_message_guard_mode: "on", stale_message_guard_minutes: 90 });
    expect((await applyStaleMessageGuard(d, input({ messageTimestamp: sec(60) }))).action).toBe("proceed");
    expect((await applyStaleMessageGuard(d, input({ messageTimestamp: sec(120) }))).action).toBe("hold");
  });
  it("fora de ordem: atrasada, atual, atrasada — só as atrasadas são retidas", async () => {
    const out: string[] = [];
    for (const m of [sec(150), sec(1), sec(95)]) out.push((await applyStaleMessageGuard(d, input({ messageTimestamp: m }))).action);
    expect(out).toEqual(["hold", "proceed", "hold"]);
  });
});

describe("falhas inesperadas", () => {
  it("falha ao ler a configuração: segue como hoje (nunca bloqueia o atendimento)", async () => {
    d = mk(null, { readSettings: vi.fn(async () => { throw new Error("db"); }) });
    const r = await applyStaleMessageGuard(d, input());
    expect(r.action).toBe("proceed");
    expect(d.startTakeover).not.toHaveBeenCalled();
  });
});
