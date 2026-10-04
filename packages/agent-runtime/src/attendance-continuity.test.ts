import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Message } from "@aula-agente/shared";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), buildTools: vi.fn(), handoff: vi.fn() }));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), generateText: mocks.generate }));
vi.mock("./tools/registry.js", () => ({ buildToolsForAgent: mocks.buildTools }));
import { runAgent } from "./agent-runner.js";
const params = (content = "tenho quatro mil e aí", sandbox = false) => ({
  agent: { id: "a", provider: "openai", model: "test", system_prompt: "published", tools_config: {}, temperature: 0, max_tokens: 300 } as Agent,
  messages: [], currentMessage: { role: "contact", content } as Message,
  apiKey: "fake", organizationId: "o", conversationId: "c", instanceId: "i", phone: "p", contactId: "ct", sandbox,
});
const response = (text: string, steps: any[] = [], extra = {}) => ({ text, steps, usage: { inputTokens: 2, outputTokens: 3 }, response: { messages: [{ role: "assistant", content: text || "tool history" }] }, ...extra });
beforeEach(() => { vi.resetAllMocks(); mocks.buildTools.mockReturnValue({ requestHuman: { execute: mocks.handoff } }); mocks.handoff.mockResolvedValue("Handoff registrado, atendimento reabrir às 8h."); });
describe("bounded attendance continuity", () => {
  it("sends operational context on every run without changing the published block", async () => {
    mocks.generate.mockResolvedValue(response("Resposta útil"));
    await runAgent(params()); await runAgent(params("o que tem de fazer para conseguir a moto"));
    for (const [options] of mocks.generate.mock.calls) {
      expect(options.system[0].content).toBe("published");
      expect(options.system[1].content).toMatch(/updateQualification/);
      expect(options.system[1].content).toMatch(/aprovação.*banc/i);
      expect(options.system[1].content).toMatch(/CPF/);
      expect(options.system[1].content).toMatch(/LiberaCred/);
    }
  });
  it.each(["tenho quatro mil e aí", "o que tem de fazer para conseguir a moto", "eu te perguntei...responde"])("recovers %s with history and sums total usage", async (question) => {
    const steps = [{ toolCalls: [{ toolCallId: "q", toolName: "updateQualification", input: { entrada: 4000 } }], toolResults: [{ toolCallId: "q", output: "salvo" }] }];
    const original = response("Fico no aguardo.", steps, { response: { messages: [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "q", toolName: "updateQualification", input: { entrada: 4000 } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "q", toolName: "updateQualification", output: { type: "text", value: "salvo" } }] },
      { role: "assistant", content: "Fico no aguardo." },
    ] }, totalUsage: { inputTokens: 20, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 5, cacheWriteTokens: 4 } } });
    mocks.generate.mockResolvedValueOnce(original).mockResolvedValueOnce(response("Com essa entrada, podemos avaliar as opções.", [], { totalUsage: { inputTokens: 7, outputTokens: 6, inputTokenDetails: { cacheReadTokens: 2 } } }));
    const result = await runAgent(params(question));
    expect(result.text).toContain("avaliar"); expect(mocks.generate).toHaveBeenCalledTimes(2);
    for (const message of original.response.messages) expect(mocks.generate.mock.calls[1][0].messages).toContainEqual(message);
    expect(mocks.generate.mock.calls[1][0].messages[0]).toEqual({ role: "user", content: question });
    expect(mocks.generate.mock.calls[1][0].system.at(-1).content).toMatch(/Responda agora diretamente/);
    expect(mocks.generate.mock.calls[1][0].tools).toBeUndefined();
    expect(result).toMatchObject({ inputTokens: 27, outputTokens: 16, cacheReadTokens: 7, cacheWriteTokens: 4, toolCalls: ["updateQualification"] });
    expect(result.toolCallTrace[0]).toMatchObject({ output: "salvo" });
  });
  it("hands off exactly once after the recovery also waits", async () => {
    mocks.generate.mockResolvedValue(response("Fico no aguardo."));
    const result = await runAgent(params());
    expect(mocks.generate).toHaveBeenCalledTimes(2); expect(mocks.handoff).toHaveBeenCalledTimes(1);
    expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ motivo: "fora_escopo", urgencia: "normal" });
    expect(result.toolCalls).toEqual(["requestHuman"]); expect(result.toolCallTrace[0].output).toContain("reabrir");
    expect(result.text).toContain("reabrir");
  });
  it.each([true, false])("does not invent handoff when sandbox=%s or the tool is unavailable", async (sandbox) => {
    if (!sandbox) mocks.buildTools.mockReturnValue({});
    mocks.generate.mockResolvedValue(response("Fico no aguardo."));
    const result = await runAgent(params(undefined, sandbox));
    expect(mocks.generate).toHaveBeenCalledTimes(2); expect(mocks.handoff).not.toHaveBeenCalled();
    expect(result.text).not.toMatch(/consultor vai|acionado|registrado/i);
  });
  it("preserves a substantive reply containing waiting words without regeneration", async () => {
    mocks.generate.mockResolvedValue(response("É preciso apresentar documentos para análise. Fico no aguardo."));
    const result = await runAgent(params("quais documentos?"));
    expect(result.text).toContain("documentos"); expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("does not claim successful handoff when the tool reports failure", async () => {
    mocks.generate.mockResolvedValue(response("Fico no aguardo."));
    mocks.handoff.mockResolvedValue("Não foi possível acionar um consultor agora");
    const result = await runAgent(params());
    expect(result.text).not.toContain("consultor vai");
    expect(result.toolCallTrace[0].output).toContain("Não foi possível");
  });
  it("does not recover empty text below the limit or for system nudges", async () => {
    mocks.generate.mockResolvedValue(response("", [{}]));
    await runAgent(params("quais documentos?")); expect(mocks.generate).toHaveBeenCalledTimes(1);
    mocks.generate.mockClear();
    mocks.generate.mockResolvedValue(response("Fico no aguardo."));
    const nudge = params("o cliente não respondeu?"); nudge.currentMessage.role = "system";
    await runAgent(nudge); expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["Handoff registrado. Avise o cliente que um consultor continua agora.", "a partir de agora", ""],
    ["Handoff registrado, mas estamos fora do horário. Um consultor continua quando reabrir.", "reabrir", ""],
    ["Handoff registrado. Avise o cliente que um consultor continua agora.", "a partir de agora", "Fico no aguardo."],
  ])("acknowledges original handoff after recovery fails: %s", async (output, expected, recoveryText) => {
    mocks.generate.mockResolvedValueOnce(response("Fico no aguardo.", [{
      toolCalls: [{ toolCallId: "h", toolName: "requestHuman", input: { motivo: "fora_escopo" } }],
      toolResults: [{ toolCallId: "h", output }],
    }])).mockResolvedValueOnce(response(recoveryText));
    const result = await runAgent(params());
    expect(result.text).toContain(expected);
    expect(result.text).not.toContain("reformular");
    expect(result.toolCalls).toEqual(["requestHuman"]);
    expect(result.toolCallTrace[0].output).toBe(output);
    expect(mocks.handoff).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ inputTokens: 4, outputTokens: 6 });
  });
  it("preserves the response and failed trace when handoff execution throws", async () => {
    mocks.generate.mockResolvedValue(response("Fico no aguardo."));
    mocks.handoff.mockRejectedValue(new Error("database unavailable"));
    const result = await runAgent(params());
    expect(result.text).toMatch(/não.*acionar.*consultor/i);
    expect(result.text).not.toMatch(/consultor vai|database unavailable/);
    expect(result.toolCalls).toEqual(["requestHuman"]);
    expect(result.toolCallTrace[0]).toMatchObject({
      tool_name: "requestHuman", mode: "real",
      output: { error: "requestHuman execution failed" },
    });
    expect(mocks.handoff).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ inputTokens: 4, outputTokens: 6 });
  });
  it.each(["real", "sandbox", "unavailable", "already-handed-off"])("contains recovery network errors after mutations in %s mode", async (mode) => {
    if (mode === "unavailable") mocks.buildTools.mockReturnValue({});
    const steps = [{
      toolCalls: [{ toolCallId: "q", toolName: "updateQualification", input: { entrada: 4000 } }],
      toolResults: [{ toolCallId: "q", output: "salvo" }],
    }];
    if (mode === "already-handed-off") steps.push({
      toolCalls: [{ toolCallId: "h", toolName: "requestHuman", input: { entrada: 4000 } }],
      toolResults: [{ toolCallId: "h", output: "Handoff registrado, atendimento reabrir às 8h." }],
    });
    mocks.generate.mockResolvedValueOnce(response("Fico no aguardo.", steps, {
      totalUsage: { inputTokens: 20, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 5, cacheWriteTokens: 4 } },
    })).mockRejectedValueOnce(new Error("recovery network failure"));
    const result = await runAgent(params(undefined, mode === "sandbox"));
    expect(result).toMatchObject({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 4 });
    expect(result.toolCallTrace[0]).toMatchObject({ tool_name: "updateQualification", output: "salvo" });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[1][0].tools).toBeUndefined();
    expect(result.text).not.toContain("recovery network failure");
    if (mode === "real" || mode === "already-handed-off") {
      expect(result.text).toContain("reabrir");
      expect(result.toolCalls).toEqual(["updateQualification", "requestHuman"]);
      expect(mocks.handoff).toHaveBeenCalledTimes(mode === "real" ? 1 : 0);
    } else {
      expect(result.text).toContain("Não consegui esclarecer");
      expect(result.text).not.toContain("consultor vai");
      expect(result.toolCalls).toEqual(["updateQualification"]);
      expect(mocks.handoff).not.toHaveBeenCalled();
    }
  });
  it("contains both recovery and handoff exceptions without another model or tool retry", async () => {
    mocks.generate.mockResolvedValueOnce(response("Fico no aguardo.")).mockRejectedValueOnce(new Error("network"));
    mocks.handoff.mockRejectedValueOnce(new Error("handoff"));
    const result = await runAgent(params());
    expect(result.text).toMatch(/não.*acionar.*consultor/i);
    expect(result).toMatchObject({ inputTokens: 2, outputTokens: 3, toolCalls: ["requestHuman"] });
    expect(result.toolCallTrace[0].output).toEqual({ error: "requestHuman execution failed" });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.handoff).toHaveBeenCalledTimes(1);
  });
  it("still propagates the initial generation error without attempting recovery or handoff", async () => {
    const error = new Error("initial generation failed");
    mocks.generate.mockRejectedValueOnce(error);
    await expect(runAgent(params())).rejects.toBe(error);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.handoff).not.toHaveBeenCalled();
  });
  it("keeps sandbox mutations simulated when recovery throws after a simulated handoff", async () => {
    mocks.generate.mockResolvedValueOnce(response("Fico no aguardo.", [{
      toolCalls: [
        { toolCallId: "q", toolName: "updateQualification", input: {} },
        { toolCallId: "h", toolName: "requestHuman", input: {} },
        { toolCallId: "i", toolName: "sendRegisteredImage", input: {} },
      ],
      toolResults: [
        { toolCallId: "q", output: "[SIMULADO] Dados de qualificação seriam atualizados agora." },
        { toolCallId: "h", output: "[SIMULADO] Um consultor seria acionado agora (motivo: fora_escopo)." },
        { toolCallId: "i", output: "[SIMULADO] Imagem seria enviada pelo WhatsApp agora." },
      ],
    }])).mockRejectedValueOnce(new Error("network"));
    const result = await runAgent(params(undefined, true));
    expect(result.toolCallTrace.map((call) => call.mode)).toEqual(["simulated", "simulated", "simulated"]);
    expect(result.text).toContain("Na simulação");
    expect(result.text).not.toContain("consultor vai");
    expect(mocks.handoff).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ inputTokens: 2, outputTokens: 3 });
  });
  it("does not claim takeover or retry after an original failed handoff", async () => {
    mocks.generate.mockResolvedValue(response("Fico no aguardo.", [{
      toolCalls: [{ toolCallId: "h", toolName: "requestHuman", input: {} }],
      toolResults: [{ toolCallId: "h", output: "Não foi possível acionar um consultor agora" }],
    }]));
    const result = await runAgent(params());
    expect(result.text).toMatch(/não.*acionar.*consultor/i);
    expect(result.text).not.toContain("consultor vai");
    expect(mocks.handoff).not.toHaveBeenCalled();
  });
  it.each(["Fico no aguardo.", ""])("recovers Ediney's exact catalog question from %s", async (text) => {
    mocks.generate.mockResolvedValueOnce(response(text, Array.from({ length: 5 }, () => ({}))))
      .mockResolvedValueOnce(response("Posso mostrar os modelos do catálogo disponíveis."));
    const result = await runAgent(params("Vc teria catálogo\nDos modelos"));
    expect(result.text).toContain("modelos do catálogo");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[1][0].messages[0]).toEqual({ role: "user", content: "Vc teria catálogo\nDos modelos" });
    expect(mocks.generate.mock.calls[1][0].tools).toBeUndefined();
    expect(mocks.handoff).not.toHaveBeenCalled();
  });
  it.each(["catálogo", "modelos", "parcela", "parcelas", "preço", "preços", "me explica", "meexplica", "teria", "vc tem", "vctem", "pode"])("recovers informal commercial inquiry: %s", async (content) => {
    mocks.generate.mockResolvedValueOnce(response("Fico no aguardo."))
      .mockResolvedValueOnce(response("Vamos esclarecer sua dúvida."));
    expect((await runAgent(params(content))).text).toBe("Vamos esclarecer sua dúvida.");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.handoff).not.toHaveBeenCalled();
  });
  it.each(["Obrigado", "Obrigado pelo catálogo", "Valeu pelos modelos", "Vou enviar o CPF depois", "Vou mandar o catálogo amanhã", "Vou enviar\nos modelos depois"])("does not recover a legitimate wait: %s", async (content) => {
    mocks.generate.mockResolvedValue(response("Fico no aguardo."));
    await runAgent(params(content)); expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("preserves empty text after sending a registered image", async () => {
    mocks.generate.mockResolvedValue(response("", Array.from({ length: 5 }, (_, i) => i ? {} : {
      toolCalls: [{ toolCallId: "image", toolName: "sendRegisteredImage", input: {} }],
      toolResults: [{ toolCallId: "image", output: "Imagem enviada." }],
    })));
    expect((await runAgent(params("quais documentos?"))).text).toBe("");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("recovers empty text at the tool limit", async () => {
    mocks.generate.mockResolvedValueOnce(response("", Array.from({ length: 5 }, () => ({ toolCalls: [] })))).mockResolvedValueOnce(response("Você precisa apresentar os documentos para análise."));
    expect((await runAgent(params("quais documentos?"))).text).toContain("documentos");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
  it("does not recover empty text after a successful photo, but does after a failed photo", async () => {
    for (const [output, count] of [["Foto enviada.", 1], ["Veículo não encontrado", 2]] as const) {
      mocks.generate.mockReset(); mocks.generate.mockResolvedValueOnce(response("", Array.from({ length: 5 }, (_, i) => i ? {} : { toolCalls: [{ toolCallId: "p", toolName: "sendVehiclePhoto", input: {} }], toolResults: [{ toolCallId: "p", output }] }))).mockResolvedValueOnce(response("Vou verificar os documentos."));
      await runAgent(params("quais documentos?")); expect(mocks.generate).toHaveBeenCalledTimes(count);
    }
  });
});
