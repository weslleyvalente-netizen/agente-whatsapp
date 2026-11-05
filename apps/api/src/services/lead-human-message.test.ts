import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ recordHumanMessage: vi.fn(), completeNudgeTasksOnSellerMessage: vi.fn() }));
vi.mock("@aula-agente/database", () => m);
import { trackFirstHumanMessage } from "./lead-human-message.js";

const base = { organizationId: "o", conversationId: "c" };
const at = new Date("2026-10-05T12:00:00Z");
beforeEach(() => { vi.clearAllMocks(); m.recordHumanMessage.mockResolvedValue("a1"); m.completeNudgeTasksOnSellerMessage.mockResolvedValue(1); });

describe("trackFirstHumanMessage (regra 6.1.1)", () => {
  it("mensagem do painel pelo vendedor registra com o autor", async () => {
    await trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "panel", actorUserId: "u1", metadata: null, at });
    expect(m.recordHumanMessage).toHaveBeenCalledWith({}, { organizationId: "o", conversationId: "c", at, authorUserId: "u1", via: "panel" });
  });
  it("eco legítimo do celular registra sem autor", async () => {
    await trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "phone_echo", metadata: null, at });
    expect(m.recordHumanMessage).toHaveBeenCalledWith({}, { organizationId: "o", conversationId: "c", at, authorUserId: null, via: "phone_echo" });
  });
  it.each([
    ["resposta da Mariana", { role: "agent", source: "panel" as const, actorUserId: "u1" }],
    ["follow-up automático (cadência)", { role: "human_agent", source: "panel" as const, actorUserId: "u1", metadata: { low_intent_followup: { stage: 1 } } }],
    ["despedida agendada", { role: "human_agent", source: "panel" as const, actorUserId: "u1", metadata: { scheduled_ad_closure: { batch_id: "b" } } }],
    ["mídia/template automático marcado", { role: "human_agent", source: "panel" as const, actorUserId: "u1", metadata: { system_generated: true } }],
    ["painel sem usuário autenticado", { role: "human_agent", source: "panel" as const, actorUserId: null }],
    ["eco de mensagem do próprio sistema", { role: "human_agent", source: "phone_echo" as const, echoMatchedSystemMessage: true }],
    ["saudação curta filtrada", { role: "human_agent", source: "phone_echo" as const, greetingFiltered: true }],
  ])("não registra: %s", async (_name, input) => {
    expect(await trackFirstHumanMessage({} as any, { ...base, metadata: null, ...input } as any)).toBeNull();
    expect(m.recordHumanMessage).not.toHaveBeenCalled();
  });
  it("nunca lança: falha do banco não bloqueia o envio da mensagem", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.recordHumanMessage.mockRejectedValue(new Error("db"));
    expect(await trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "panel", actorUserId: "u1", metadata: null })).toBeNull();
    log.mockRestore();
  });
  it("mensagem humana comprovada conclui o cutucar da conversa na hora", async () => {
    await trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "panel", actorUserId: "u1", metadata: null, at });
    expect(m.completeNudgeTasksOnSellerMessage).toHaveBeenCalledWith({}, "o", "c", at.toISOString());
  });
  it("mensagem da IA ou automática não conclui o cutucar", async () => {
    await trackFirstHumanMessage({} as any, { ...base, role: "agent", source: "panel", actorUserId: "u1", metadata: null });
    await trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "panel", actorUserId: "u1", metadata: { system_generated: true } });
    expect(m.completeNudgeTasksOnSellerMessage).not.toHaveBeenCalled();
  });
  it("falha ao concluir o cutucar não impede o registro da primeira resposta", async () => {
    m.completeNudgeTasksOnSellerMessage.mockRejectedValue(new Error("db"));
    await expect(trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "panel", actorUserId: "u1", metadata: null, at })).resolves.toBe("a1");
  });
});
