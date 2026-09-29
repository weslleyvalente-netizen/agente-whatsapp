import { describe, it, expect } from "vitest";
import { matchPendingOutboundMessage } from "./message-echo-match.js";

function candidate(overrides: Partial<{ id: string; content: string; media_type: string | null; created_at: string }> = {}) {
  return {
    id: "msg-1",
    content: "Oi! Ainda pensando na proposta?",
    media_type: null,
    created_at: "2026-09-29T12:00:00.000Z",
    ...overrides,
  };
}

describe("matchPendingOutboundMessage", () => {
  it("matches a text candidate with identical content", () => {
    const result = matchPendingOutboundMessage(
      [candidate()],
      { mediaType: null, content: "Oi! Ainda pensando na proposta?" }
    );
    expect(result?.id).toBe("msg-1");
  });

  it("does not match a text candidate with different content", () => {
    const result = matchPendingOutboundMessage(
      [candidate({ content: "Outro texto" })],
      { mediaType: null, content: "Oi! Ainda pensando na proposta?" }
    );
    expect(result).toBeNull();
  });

  // Evolution's echo for outbound audio never carries our real text back —
  // extractByType returns a fixed "[audio]" placeholder for any audioMessage
  // (apps/api/src/routes/webhooks/evolution.ts) — so audio/image/video/etc.
  // match by media_type alone, never by content.
  it("matches an audio candidate by media_type alone, ignoring content", () => {
    const result = matchPendingOutboundMessage(
      [candidate({ media_type: "audio", content: "texto do TTS que nunca vai bater" })],
      { mediaType: "audio", content: "[audio]" }
    );
    expect(result?.id).toBe("msg-1");
  });

  it("matches an image candidate by media_type alone", () => {
    const result = matchPendingOutboundMessage(
      [candidate({ media_type: "image", content: "FZ15 Fazer ABS Connected" })],
      { mediaType: "image", content: "[imagem]" }
    );
    expect(result?.id).toBe("msg-1");
  });

  it("does not match a media candidate against a text incoming echo or vice versa", () => {
    const result = matchPendingOutboundMessage(
      [candidate({ media_type: "audio" })],
      { mediaType: null, content: "Oi!" }
    );
    expect(result).toBeNull();
  });

  it("does not match a different media_type", () => {
    const result = matchPendingOutboundMessage(
      [candidate({ media_type: "image" })],
      { mediaType: "audio", content: "[audio]" }
    );
    expect(result).toBeNull();
  });

  it("picks the oldest match when multiple identical pending candidates exist", () => {
    const older = candidate({ id: "msg-older", created_at: "2026-09-29T11:00:00.000Z" });
    const newer = candidate({ id: "msg-newer", created_at: "2026-09-29T12:00:00.000Z" });
    const result = matchPendingOutboundMessage(
      [newer, older],
      { mediaType: null, content: "Oi! Ainda pensando na proposta?" }
    );
    expect(result?.id).toBe("msg-older");
  });

  it("returns null when there are no candidates", () => {
    expect(matchPendingOutboundMessage([], { mediaType: null, content: "Oi!" })).toBeNull();
  });
});
