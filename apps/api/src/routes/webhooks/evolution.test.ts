import { describe, it, expect } from "vitest";
import { extractMessageContent } from "./evolution.js";

describe("extractMessageContent", () => {
  it("extracts plain text from a conversation message", () => {
    const result = extractMessageContent({
      messageType: "conversation",
      message: { conversation: "Oi, tudo bem?" },
    });
    expect(result).toEqual({ content: "Oi, tudo bem?", mediaType: null });
  });

  it("falls back to a placeholder for an empty text message", () => {
    const result = extractMessageContent({
      messageType: "conversation",
      message: { conversation: "" },
    });
    expect(result.content).not.toBe("");
    expect(result.content).toBe("[mensagem não suportada]");
  });

  it("falls back to a placeholder when there is no message payload", () => {
    const result = extractMessageContent({ messageType: "conversation" });
    expect(result.content).not.toBe("");
  });

  it("falls back to a placeholder for an unhandled message type (reactions, protocol messages, etc.)", () => {
    const result = extractMessageContent({
      messageType: "reactionMessage",
      message: { reactionMessage: { text: "👍" } },
    });
    expect(result.content).not.toBe("");
    expect(result.content).toBe("[mensagem não suportada]");
  });

  it("passes through the voice note duration for audio messages", () => {
    const result = extractMessageContent({
      messageType: "audioMessage",
      message: { audioMessage: { seconds: 12 } },
    });
    expect(result).toEqual({ content: "[audio]", mediaType: "audio", durationSeconds: 12 });
  });

  it("omits durationSeconds when the audio message has no seconds field", () => {
    const result = extractMessageContent({
      messageType: "audioMessage",
      message: { audioMessage: {} },
    });
    expect(result.durationSeconds).toBeUndefined();
  });

  it("never returns empty content, across every message type", () => {
    const types = [
      "conversation",
      "imageMessage",
      "audioMessage",
      "videoMessage",
      "documentMessage",
      "stickerMessage",
      "locationMessage",
      "somethingUnknown",
    ];
    for (const messageType of types) {
      const result = extractMessageContent({ messageType, message: {} });
      expect(result.content.trim()).not.toBe("");
    }
  });
});
