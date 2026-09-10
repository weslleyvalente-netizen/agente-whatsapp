import { describe, it, expect } from "vitest";
import { evolutionWebhookPayloadSchema } from "./evolution.js";

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "messages.upsert",
    instance: "weslley",
    data: {
      key: { remoteJid: "556293227531@s.whatsapp.net", fromMe: false, id: "ABC123" },
      message: { conversation: "Olá! Posso ter mais informações sobre isso?" },
      messageType: "conversation",
      ...overrides,
    },
  };
}

describe("evolutionWebhookPayloadSchema", () => {
  // Real production payload dropped a customer's first message from a
  // Click-to-WhatsApp ad: Evolution sends an explicit `null` for contextInfo
  // when there's no ad context, not an absent key, and the schema's plain
  // .optional() rejected it with a 400 before the agent ever saw the message.
  it("accepts contextInfo: null (Evolution's shape for 'no ad context')", () => {
    const result = evolutionWebhookPayloadSchema.safeParse(basePayload({ contextInfo: null }));
    expect(result.success).toBe(true);
  });

  it("accepts message: null (Evolution's shape for content-less events)", () => {
    const result = evolutionWebhookPayloadSchema.safeParse(basePayload({ message: null }));
    expect(result.success).toBe(true);
  });

  it("still accepts a real externalAdReply context", () => {
    const result = evolutionWebhookPayloadSchema.safeParse(
      basePayload({
        contextInfo: { externalAdReply: { title: "Compre sua bike elétrica", body: "Simulação gratuita" } },
      })
    );
    expect(result.success).toBe(true);
  });

  it("still accepts a payload with contextInfo omitted entirely", () => {
    const result = evolutionWebhookPayloadSchema.safeParse(basePayload());
    expect(result.success).toBe(true);
  });
});
