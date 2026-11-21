import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ resolve: vi.fn(), find: vi.fn() }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveWhatsAppTarget: m.resolve, uazapiFindMessages: m.find }));

import { findStoredMessages } from "./evolution.service.js";

const msg = (id: string, fromMe: boolean, extra: Record<string, unknown> = {}) => ({
  messageid: id, chatid: "5562999990000@s.whatsapp.net", fromMe, isGroup: false, messageType: "Conversation", text: "oi",
  senderName: "Cliente", messageTimestamp: 1_788_868_800_000, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.resolve.mockResolvedValue({ provider: "uazapi", instanceName: "weslley", token: "tok" });
});

describe("findStoredMessages com a instância na UAZAPI", () => {
  it("busca na UAZAPI pela janela em ms e devolve no formato interno, só da direção pedida", async () => {
    m.find.mockResolvedValue([msg("R1", false), msg("S1", true), msg("G1", false, { isGroup: true, chatid: "1@g.us" })]);
    const out = await findStoredMessages("weslley", { gteSec: 1_788_868_000, lteSec: 1_788_869_000 }, false);
    expect(m.find).toHaveBeenCalledWith("tok", { sinceMs: 1_788_868_000_000, untilMs: 1_788_869_000_999 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: { id: "R1", fromMe: false, remoteJid: "5562999990000@s.whatsapp.net" }, messageType: "conversation", messageTimestamp: 1_788_868_800 });
    expect(out[0].message).toMatchObject({ conversation: "oi" });
  });

  it("enviadas (fromMe=true)", async () => {
    m.find.mockResolvedValue([msg("R1", false), msg("S1", true)]);
    const out = await findStoredMessages("weslley", { gteSec: 0, lteSec: 2_000_000_000 }, true);
    expect(out.map((r) => r.key.id)).toEqual(["S1"]);
  });
});
