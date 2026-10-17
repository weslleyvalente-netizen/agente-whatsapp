import { describe, it, expect, vi, beforeEach } from "vitest";

const gen = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), generateText: gen.generateText }));
import { runAgent } from "./agent-runner.js";

const agent: any = {
  id: "a1", provider: "anthropic", model: "claude-x", system_prompt: "Você é a Helena.", temperature: 0.2, max_tokens: 500,
  tools_config: { search_knowledge: false, search_faq: true, send_catalog_photo: true, create_task: true, request_human: true, update_qualification: false, audio_replies: false, audio_voice: "alloy" },
};
const base = {
  agent, messages: [], apiKey: "k", organizationId: "o", conversationId: "c", instanceId: "i", phone: "55", contactId: "ct",
  currentMessage: { role: "contact", content: "qual o preço da Fazer?" } as any,
};
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const res = (text: string, steps: unknown[] = []) => ({ text, steps, response: { messages: [] }, usage, totalUsage: usage });

beforeEach(() => {
  gen.generateText.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("runAgent in after-hours pending mode", () => {
  it("passes tools without requestHuman/createTask and a third system block with the real reopening", async () => {
    gen.generateText.mockResolvedValue(res("R$ 18.000"));
    await runAgent({ ...base, afterHoursPending: true, afterHoursReopensAt: "segunda, 20/10, às 08:00" });
    const call = gen.generateText.mock.calls[0][0];
    expect(Object.keys(call.tools)).not.toContain("requestHuman");
    expect(Object.keys(call.tools)).not.toContain("createTask");
    expect(Object.keys(call.tools)).toContain("searchFaq");
    expect(call.system).toHaveLength(3);
    expect(call.system[2].content).toContain("a equipe retoma segunda, 20/10, às 08:00");
    expect(call.system[1].content).not.toMatch(/requestHuman/);
  });

  it("normal mode keeps both tools and two system blocks", async () => {
    gen.generateText.mockResolvedValue(res("ok"));
    await runAgent(base);
    const call = gen.generateText.mock.calls[0][0];
    expect(Object.keys(call.tools)).toEqual(expect.arrayContaining(["requestHuman", "createTask"]));
    expect(call.system).toHaveLength(2);
  });

  it("recovery path never hands off in this mode", async () => {
    gen.generateText.mockResolvedValueOnce(res("Fico no aguardo")).mockResolvedValueOnce(res(""));
    const r = await runAgent({ ...base, afterHoursPending: true });
    expect(r.toolCalls).not.toContain("requestHuman");
    expect(r.text).not.toMatch(/consultor vai continuar/);
    expect(gen.generateText).toHaveBeenCalledTimes(2);
    expect(gen.generateText.mock.calls[1][0].system).toHaveLength(4);
  });
});
