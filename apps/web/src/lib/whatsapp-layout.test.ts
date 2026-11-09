import { describe, expect, it } from "vitest";
import { WA_THEME, composerHeight, messageTick, startsBubbleGroup } from "./whatsapp-layout";

describe("messageTick", () => {
  it("human_agent com evolution_message_id: enviado", () => {
    expect(messageTick({ role: "human_agent", evolution_message_id: "ABC", metadata: null })).toBe("sent");
  });
  it("agent com evolution_message_id: enviado", () => {
    expect(messageTick({ role: "agent", evolution_message_id: "ABC", metadata: {} })).toBe("sent");
  });
  it("sem id e sem falha: nada", () => {
    expect(messageTick({ role: "human_agent", evolution_message_id: null, metadata: null })).toBeNull();
    expect(messageTick({ role: "agent", evolution_message_id: null, metadata: {} })).toBeNull();
  });
  it("com send_failed_at: falhou (mesmo com id)", () => {
    expect(messageTick({ role: "human_agent", evolution_message_id: null, metadata: { send_failed_at: "2026-11-08T10:00:00Z" } })).toBe("failed");
    expect(messageTick({ role: "agent", evolution_message_id: "ABC", metadata: { send_failed_at: "2026-11-08T10:00:00Z" } })).toBe("failed");
  });
  it("contato e sistema: nada", () => {
    expect(messageTick({ role: "contact", evolution_message_id: "ABC", metadata: null })).toBeNull();
    expect(messageTick({ role: "contact", evolution_message_id: null, metadata: { send_failed_at: "x" } })).toBeNull();
    expect(messageTick({ role: "system", evolution_message_id: "ABC", metadata: null })).toBeNull();
  });
});

describe("startsBubbleGroup", () => {
  const at = "2026-11-08T12:00:00Z";
  it("primeira mensagem abre grupo", () => {
    expect(startsBubbleGroup(undefined, { role: "contact", created_at: at })).toBe(true);
  });
  it("mesmo lado em seguida não abre grupo", () => {
    expect(startsBubbleGroup({ role: "contact", created_at: at }, { role: "contact", created_at: at })).toBe(false);
    expect(startsBubbleGroup({ role: "agent", created_at: at }, { role: "human_agent", created_at: at })).toBe(false);
  });
  it("troca de lado abre grupo", () => {
    expect(startsBubbleGroup({ role: "contact", created_at: at }, { role: "agent", created_at: at })).toBe(true);
    expect(startsBubbleGroup({ role: "human_agent", created_at: at }, { role: "contact", created_at: at })).toBe(true);
  });
  it("depois de mensagem de sistema abre grupo", () => {
    expect(startsBubbleGroup({ role: "system", created_at: at }, { role: "contact", created_at: at })).toBe(true);
  });
  it("troca de dia abre grupo", () => {
    expect(startsBubbleGroup({ role: "contact", created_at: "2026-11-07T15:00:00Z" }, { role: "contact", created_at: at })).toBe(true);
  });
});

describe("composerHeight", () => {
  // linha de 20px, 16px de padding vertical somado, até 6 linhas => teto 136px
  it("nunca menor que uma linha", () => {
    expect(composerHeight(0, 20, 16, 6)).toBe(36);
    expect(composerHeight(10, 20, 16, 6)).toBe(36);
  });
  it("acompanha o conteúdo até o teto", () => {
    expect(composerHeight(76, 20, 16, 6)).toBe(76);
  });
  it("trava em 6 linhas", () => {
    expect(composerHeight(500, 20, 16, 6)).toBe(136);
  });
});

describe("WA_THEME", () => {
  it("usa as cores combinadas", () => {
    expect(WA_THEME.chatBg).toContain("bg-[#efeae2]");
    expect(WA_THEME.bubbleIn).toContain("bg-white");
    expect(WA_THEME.bubbleOut).toContain("bg-[#d9fdd3]");
    expect(WA_THEME.header).toContain("bg-[#f0f2f5]");
    expect(WA_THEME.accentBg).toContain("bg-[#00a884]");
  });
  it("toda classe de cor tem variante escura", () => {
    for (const key of ["chatBg", "bubbleIn", "bubbleOut", "header", "panel"] as const) {
      expect(WA_THEME[key]).toMatch(/dark:bg-/);
    }
  });
});
