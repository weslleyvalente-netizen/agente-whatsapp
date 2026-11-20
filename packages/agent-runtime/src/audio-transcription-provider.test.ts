import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ resolve: vi.fn(), download: vi.fn() }));
vi.mock("./whatsapp/target.js", () => ({ resolveWhatsAppTarget: m.resolve }));
vi.mock("./whatsapp/uazapi.js", () => ({ uazapiDownloadMedia: m.download }));

import { fetchAudioAsMp4, fetchMediaBase64 } from "./audio-transcription.js";

beforeEach(() => {
  m.resolve.mockReset(); m.download.mockReset();
  m.resolve.mockResolvedValue({ provider: "uazapi", instanceName: "w", token: "tok" });
  m.download.mockResolvedValue({ base64: "YWJj", mimetype: "audio/mpeg" });
});

describe("mídia pelo provedor ativo", () => {
  it("áudio para transcrição: UAZAPI em mp3", async () => {
    expect(await fetchAudioAsMp4("w", "MSG1", 5000)).toEqual({ base64: "YWJj", mimetype: "audio/mpeg" });
    expect(m.download).toHaveBeenCalledWith("tok", "MSG1", { timeoutMs: 5000, mp3: true });
  });

  it("mídia: repassa o limite de bytes", async () => {
    await fetchMediaBase64("w", "MSG2", 6000, { maxBytes: 1234 });
    expect(m.download).toHaveBeenCalledWith("tok", "MSG2", { timeoutMs: 6000, maxBytes: 1234 });
  });

  it("instância em UAZAPI sem token: o erro sobe (não cai para a Evolution)", async () => {
    m.resolve.mockRejectedValue(new Error("instância em UAZAPI sem token: conecte a UAZAPI antes de virar"));
    await expect(fetchMediaBase64("w", "MSG3")).rejects.toThrow("sem token");
  });
});
