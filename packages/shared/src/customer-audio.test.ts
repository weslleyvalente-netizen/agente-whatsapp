import { describe, expect, it } from "vitest";
import {
  CUSTOMER_AUDIO_BUCKET,
  CUSTOMER_AUDIO_RETENTION_DAYS,
  buildCustomerAudioRef,
  parseCustomerAudioRef,
  isStoredCustomerAudioRef,
} from "./customer-audio.js";

describe("customer audio ref", () => {
  it("monta a referência estável sem URL assinada", () => {
    expect(buildCustomerAudioRef({ organizationId: "org", conversationId: "conv", messageId: "msg", extension: "mp4" })).toBe(
      "storage:customer-audio/org/conv/msg.mp4"
    );
  });

  it("extrai bucket e caminho de uma referência válida", () => {
    expect(parseCustomerAudioRef("storage:customer-audio/org/conv/msg.mp4")).toEqual({
      bucket: CUSTOMER_AUDIO_BUCKET,
      path: "org/conv/msg.mp4",
    });
  });

  it("rejeita URLs http, outros buckets, nulos e caminhos vazios", () => {
    expect(parseCustomerAudioRef("https://x/y.mp4")).toBeNull();
    expect(parseCustomerAudioRef("storage:agent-media/a/b.png")).toBeNull();
    expect(parseCustomerAudioRef(null)).toBeNull();
    expect(parseCustomerAudioRef("storage:customer-audio/")).toBeNull();
    expect(parseCustomerAudioRef("storage:customer-audio/../x")).toBeNull();
    expect(isStoredCustomerAudioRef("storage:customer-audio/a/b/c.mp4")).toBe(true);
    expect(isStoredCustomerAudioRef("storage:other/a")).toBe(false);
  });

  it("retenção é de 90 dias", () => {
    expect(CUSTOMER_AUDIO_RETENTION_DAYS).toBe(90);
  });
});
