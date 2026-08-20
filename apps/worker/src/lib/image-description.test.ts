import { describe, it, expect, vi, afterEach } from "vitest";

const { generateText, createModel } = vi.hoisted(() => ({ generateText: vi.fn(), createModel: vi.fn() }));
vi.mock("ai", () => ({ generateText }));
vi.mock("@aula-agente/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aula-agente/agent-runtime")>();
  return { ...actual, createModel };
});

import { buildImageDescriptionPrompt, exceedsSizeCap, describeImageMessage } from "./image-description.js";

describe("buildImageDescriptionPrompt", () => {
  it("returns the base prompt when there is no caption", () => {
    const prompt = buildImageDescriptionPrompt();
    expect(prompt).toContain("Descreva em português");
    expect(prompt).not.toContain("escreveu junto");
  });

  it("appends the caption as extra context when present", () => {
    const prompt = buildImageDescriptionPrompt("quanto vale essa?");
    expect(prompt).toContain("Descreva em português");
    expect(prompt).toContain('"quanto vale essa?"');
  });
});

describe("describeImageMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("returns the token usage alongside the description, so the caller can log its cost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ base64: "aGVsbG8=", mimetype: "image/jpeg" }) })
    );
    createModel.mockReturnValue("mock-model");
    generateText.mockResolvedValue({
      text: "Uma moto vermelha.",
      usage: { inputTokens: 1500, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 } },
    });

    const result = await describeImageMessage({
      instanceName: "inst-1",
      evolutionMessageId: "msg-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "key",
    });

    expect(result).toEqual({
      ok: true,
      text: "Uma moto vermelha.",
      usage: { inputTokens: 1500, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });
});

describe("exceedsSizeCap", () => {
  it("returns false for an image under 10 MB", () => {
    expect(exceedsSizeCap(5 * 1024 * 1024)).toBe(false);
  });

  it("returns false for exactly 10 MB", () => {
    expect(exceedsSizeCap(10 * 1024 * 1024)).toBe(false);
  });

  it("returns true for an image over 10 MB", () => {
    expect(exceedsSizeCap(10 * 1024 * 1024 + 1)).toBe(true);
  });
});
