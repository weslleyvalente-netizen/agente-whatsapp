import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMediaBase64, EvolutionMediaTooLargeError } from "./audio-transcription.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(headers: Record<string, string>, body: unknown) {
  const json = vi.fn().mockResolvedValue(body);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(headers), json }));
  return json;
}

describe("fetchMediaBase64: limite antes de ler o corpo", () => {
  it("rejeita pelo Content-Length sem ler o corpo", async () => {
    const json = stubFetch({ "content-length": String(40 * 1024 * 1024) }, { base64: "x" });
    await expect(fetchMediaBase64("inst", "id", 1000, { maxBytes: 16 * 1024 * 1024 })).rejects.toBeInstanceOf(EvolutionMediaTooLargeError);
    expect(json).not.toHaveBeenCalled();
  });

  it("dentro do limite lê normalmente", async () => {
    const json = stubFetch({ "content-length": "1000" }, { base64: "YWJj", mimetype: "image/png" });
    expect(await fetchMediaBase64("inst", "id", 1000, { maxBytes: 16 * 1024 * 1024 })).toMatchObject({ base64: "YWJj", mimetype: "image/png" });
    expect(json).toHaveBeenCalled();
  });

  it("sem Content-Length ou sem opção, não rejeita", async () => {
    stubFetch({}, { base64: "YWJj" });
    await expect(fetchMediaBase64("inst", "id", 1000, { maxBytes: 10 })).resolves.toMatchObject({ base64: "YWJj" });
    stubFetch({ "content-length": "999999999" }, { base64: "YWJj" });
    await expect(fetchMediaBase64("inst", "id", 1000)).resolves.toMatchObject({ base64: "YWJj" });
  });
});
