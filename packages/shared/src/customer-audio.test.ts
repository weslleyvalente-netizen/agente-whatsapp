import { describe, expect, it } from "vitest";
import {
  CUSTOMER_AUDIO_BUCKET,
  CUSTOMER_AUDIO_RETENTION_DAYS,
  buildCustomerAudioRef,
  parseCustomerAudioRef,
  isStoredCustomerAudioRef,
  isCustomerAudioRefFor,
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

describe("isCustomerAudioRefFor", () => {
  const ids = { organizationId: "o", conversationId: "c", messageId: "m" };
  it("aceita só o caminho exato da própria mensagem com extensão permitida", () => {
    for (const ext of ["mp4", "mp3", "wav", "webm", "ogg"]) expect(isCustomerAudioRefFor(`storage:customer-audio/o/c/m.${ext}`, ids)).toBe(true);
  });
  it("rejeita outra org/conversa/mensagem, extensão fora da lista, traversal e nulos", () => {
    for (const ref of [
      "storage:customer-audio/x/c/m.mp4", "storage:customer-audio/o/x/m.mp4", "storage:customer-audio/o/c/x.mp4",
      "storage:customer-audio/o/c/m.exe", "storage:customer-audio/o/c/m.mp4/../../x.mp4", "storage:customer-audio/o/c/m",
      "storage:agent-media/o/c/m.mp4", "https://o/c/m.mp4", null, undefined,
    ]) expect(isCustomerAudioRefFor(ref as any, ids)).toBe(false);
  });
});
