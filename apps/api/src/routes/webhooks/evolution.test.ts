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

  it("prepends the ad context when the customer replied from a Click-to-WhatsApp ad", () => {
    // Real production case: a customer tapped an Instagram ad for the
    // LiberaCred campaign and WhatsApp sent "Olá! Posso ter mais
    // informações sobre isso?" as the message text — generic, with no
    // mention of what "isso" refers to. Evolution API does deliver the ad's
    // title/body via data.contextInfo.externalAdReply (confirmed against
    // the real payload via /chat/findMessages), but nothing read it, so the
    // agent had zero context to explain what the customer meant by "isso".
    const result = extractMessageContent({
      messageType: "conversation",
      message: { conversation: "Olá! Posso ter mais informações sobre isso?" },
      contextInfo: {
        externalAdReply: {
          title: "Conquiste sua moto com o Libera Cred",
          body: "Com o Libera Cred, você encontra opções de crédito exclusivas para motos, inclusive para negativados.",
          sourceType: "ad",
          sourceApp: "instagram",
        },
      },
    });
    expect(result.content).toContain("Conquiste sua moto com o Libera Cred");
    expect(result.content).toContain("Olá! Posso ter mais informações sobre isso?");
  });

  it("leaves content untouched when contextInfo has no externalAdReply", () => {
    const result = extractMessageContent({
      messageType: "conversation",
      message: { conversation: "Oi" },
      contextInfo: { mentionedJid: [] },
    });
    expect(result.content).toBe("Oi");
  });
});
