import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.EVOLUTION_API_URL = "http://evo.test";
process.env.EVOLUTION_API_KEY = "k";

const { findStoredMessages } = await import("./evolution.service.js");

const rec = (id: string, ts: number) => ({ key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id }, messageType: "conversation", messageTimestamp: ts });
const reply = (records: unknown[], pages = 1) => ({ ok: true, json: async () => ({ messages: { records, pages } }) });

describe("findStoredMessages", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("usa o filtro de data quando a Evolution responde", async () => {
    fetchMock.mockResolvedValueOnce(reply([rec("a", 150)]));
    const out = await findStoredMessages("i", { gteSec: 100, lteSec: 200 }, false);
    expect(out.map((r) => r.key.id)).toEqual(["a"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sem resultado no filtro, busca sem filtro e recorta a janela aqui, parando ao passar da janela", async () => {
    fetchMock
      .mockResolvedValueOnce(reply([]))                                  // filtrada: vazia
      .mockResolvedValueOnce(reply([rec("n", 300), rec("a", 150)], 3))   // p1 (mais novas primeiro)
      .mockResolvedValueOnce(reply([rec("b", 120), rec("c", 110)], 4))   // p2: ainda na janela
      .mockResolvedValueOnce(reply([rec("old", 50), rec("older", 10)], 4)) // p3: inteira antes da janela, para
      .mockResolvedValueOnce(reply([rec("never", 5)], 4));               // p4 não deve ser pedida
    const out = await findStoredMessages("i", { gteSec: 100, lteSec: 200 }, false);
    expect(out.map((r) => r.key.id)).toEqual(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
