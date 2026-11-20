import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UazapiHttpError, uazapiAvatarUrl, uazapiConnect, uazapiCreateInstance, uazapiDownloadMedia, uazapiSendMedia, uazapiSendText, uazapiSetWebhook, uazapiStatus,
} from "./uazapi.js";
import { EvolutionMediaTooLargeError } from "./media-errors.js";

type R = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: Uint8Array };
const res = (r: R) => {
  const raw = r.raw ?? new TextEncoder().encode(JSON.stringify(r.body ?? {}));
  return new Response(raw as unknown as BodyInit, { status: r.status ?? 200, headers: r.headers });
};
let fetchMock: ReturnType<typeof vi.fn>;
const queue = (...rs: R[]) => { for (const r of rs) fetchMock.mockResolvedValueOnce(res(r)); };
const call = (i: number) => ({ url: String(fetchMock.mock.calls[i][0]), init: fetchMock.mock.calls[i][1] as RequestInit });

beforeEach(() => {
  vi.stubEnv("UAZAPI_BASE_URL", "https://x.uazapi.com/");
  vi.stubEnv("UAZAPI_ADMIN_TOKEN", "admin-1");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("envio", () => {
  it("texto: endpoint, cabeçalho token, corpo e id no formato da Evolution", async () => {
    queue({ body: { messageid: "3EB0X", id: "r123" } });
    expect(await uazapiSendText("tok", "5562999990000", "oi")).toEqual({ key: { id: "3EB0X" } });
    const { url, init } = call(0);
    expect(url).toBe("https://x.uazapi.com/send/text");
    expect((init.headers as Record<string, string>).token).toBe("tok");
    expect(JSON.parse(String(init.body))).toEqual({ number: "5562999990000", text: "oi" });
  });

  it("mídia: campos ausentes não vão", async () => {
    queue({ body: { messageid: "M1" } });
    await uazapiSendMedia("tok", "556299", { type: "document", file: "https://f", docName: "a.pdf" });
    expect(call(0).url).toBe("https://x.uazapi.com/send/media");
    expect(JSON.parse(String(call(0).init.body))).toEqual({ number: "556299", type: "document", file: "https://f", docName: "a.pdf" });
  });

  it("429 com Retry-After: espera e tenta de novo uma vez", async () => {
    queue({ status: 429, headers: { "retry-after": "1" } }, { body: { messageid: "OK" } });
    expect(await uazapiSendText("tok", "1", "x")).toEqual({ key: { id: "OK" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 duas vezes: UazapiHttpError 429", async () => {
    queue({ status: 429, headers: { "retry-after": "0" } }, { status: 429, headers: { "retry-after": "0" } });
    await expect(uazapiSendText("tok", "1", "x")).rejects.toMatchObject({ name: "UazapiHttpError", status: 429 });
  });

  it("500: UazapiHttpError com o status na mensagem", async () => {
    queue({ status: 500, body: { error: "boom" } });
    const err = await uazapiSendText("tok", "1", "x").catch((e) => e);
    expect(err).toBeInstanceOf(UazapiHttpError);
    expect(err.message).toContain("500");
  });
});

describe("download de mídia", () => {
  it("Content-Length acima do limite: EvolutionMediaTooLargeError sem ler o arquivo", async () => {
    queue({ body: { fileURL: "https://cdn/f.ogg", mimetype: "audio/ogg" } }, { raw: new Uint8Array(10), headers: { "content-length": "10000" } });
    await expect(uazapiDownloadMedia("tok", "MSG1", { timeoutMs: 1000, maxBytes: 1000 })).rejects.toBeInstanceOf(EvolutionMediaTooLargeError);
    expect(JSON.parse(String(call(0).init.body))).toEqual({ id: "MSG1", generate_mp3: false, return_link: true });
  });

  it("sem Content-Length, corpo maior que o limite: também rejeita", async () => {
    queue({ body: { fileURL: "https://cdn/f", mimetype: "image/png" } }, { raw: new Uint8Array(2000) });
    await expect(uazapiDownloadMedia("tok", "MSG1", { timeoutMs: 1000, maxBytes: 1000 })).rejects.toBeInstanceOf(EvolutionMediaTooLargeError);
  });

  it("dentro do limite: base64 do arquivo e mimetype do /message/download", async () => {
    queue({ body: { fileURL: "https://cdn/f", mimetype: "audio/mpeg" } }, { raw: new TextEncoder().encode("abc"), headers: { "content-length": "3" } });
    expect(await uazapiDownloadMedia("tok", "MSG1", { timeoutMs: 1000, maxBytes: 1000, mp3: true })).toEqual({ base64: "YWJj", mimetype: "audio/mpeg" });
    expect(JSON.parse(String(call(0).init.body)).generate_mp3).toBe(true);
    expect(call(1).url).toBe("https://cdn/f");
  });
});

describe("foto e administração", () => {
  it("avatar vazio = null", async () => {
    queue({ body: { url: "" } });
    expect(await uazapiAvatarUrl("tok", "556299")).toBeNull();
    queue({ body: { url: "https://pic" } });
    expect(await uazapiAvatarUrl("tok", "556299")).toBe("https://pic");
  });

  it("criar instância usa admintoken e devolve o token", async () => {
    queue({ body: { token: "novo", instance: { token: "novo" } } });
    expect(await uazapiCreateInstance("weslley")).toEqual({ token: "novo" });
    expect((call(0).init.headers as Record<string, string>).admintoken).toBe("admin-1");
    expect(JSON.parse(String(call(0).init.body))).toEqual({ name: "weslley" });
  });

  it("webhook com os três eventos e sem grupos", async () => {
    queue({ body: {} });
    await uazapiSetWebhook("tok", "https://api/webhooks/uazapi?apikey=s");
    expect(JSON.parse(String(call(0).init.body))).toEqual({
      enabled: true, url: "https://api/webhooks/uazapi?apikey=s", events: ["messages", "messages_update", "connection"], excludeMessages: ["isGroupYes"],
    });
  });

  it("connect devolve QR; 409 cai para /instance/status", async () => {
    queue({ body: { instance: { status: "connecting", qrcode: "data:image/png;base64,AA", paircode: "" } } });
    expect(await uazapiConnect("tok")).toEqual({ status: "connecting", qrcode: "data:image/png;base64,AA", paircode: null });
    queue({ status: 409, body: {} }, { body: { instance: { status: "connecting", qrcode: null, paircode: "ABCD-1234" } } });
    expect(await uazapiConnect("tok", "5562999990000")).toEqual({ status: "connecting", qrcode: null, paircode: "ABCD-1234" });
    expect(JSON.parse(String(call(1).init.body))).toEqual({ phone: "5562999990000" });
    expect(call(2).url).toBe("https://x.uazapi.com/instance/status");
  });

  it("status sem instância = disconnected", async () => {
    queue({ body: {} });
    expect(await uazapiStatus("tok")).toEqual({ status: "disconnected", qrcode: null, paircode: null });
  });
});
