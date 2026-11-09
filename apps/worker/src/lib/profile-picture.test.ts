import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ getInstanceById: vi.fn(), setContactProfilePicture: vi.fn() }));
vi.mock("@aula-agente/database", () => m);
import { fetchContactProfilePicture } from "./profile-picture.js";

const job = { contactId: "ct", organizationId: "org", instanceId: "inst", phone: "5511999999999" };

function makeDb() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  return { db: { storage: { from: vi.fn(() => ({ upload })) } } as any, upload };
}
const fetchPictureUrl = vi.fn();
const downloadImage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  m.getInstanceById.mockResolvedValue({ instance_name: "minha-instancia" });
  m.setContactProfilePicture.mockResolvedValue(undefined);
  fetchPictureUrl.mockResolvedValue("https://pps.whatsapp.net/x.jpg");
  downloadImage.mockResolvedValue({ buffer: Buffer.from("img"), contentType: "image/jpeg" });
});

describe("fetchContactProfilePicture", () => {
  it("foto oculta (URL nula): marca a tentativa e não sobe nada", async () => {
    fetchPictureUrl.mockResolvedValue(null);
    const { db, upload } = makeDb();
    expect(await fetchContactProfilePicture(db, job, { fetchPictureUrl, downloadImage })).toEqual({ ok: true, stored: false });
    expect(fetchPictureUrl).toHaveBeenCalledWith("minha-instancia", "5511999999999");
    expect(upload).not.toHaveBeenCalled();
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
  });

  it("URL válida + jpeg: sobe com upsert no bucket privado e grava o caminho", async () => {
    const { db, upload } = makeDb();
    expect(await fetchContactProfilePicture(db, job, { fetchPictureUrl, downloadImage })).toEqual({ ok: true, stored: true });
    expect(db.storage.from).toHaveBeenCalledWith("profile-pictures");
    expect(upload).toHaveBeenCalledWith("org/ct.jpg", expect.any(Buffer), { contentType: "image/jpeg", upsert: true });
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", "org/ct.jpg");
  });

  it("deriva a extensão do content-type (png, webp)", async () => {
    const { db, upload } = makeDb();
    downloadImage.mockResolvedValue({ buffer: Buffer.from("i"), contentType: "image/webp" });
    await fetchContactProfilePicture(db, job, { fetchPictureUrl, downloadImage });
    expect(upload).toHaveBeenCalledWith("org/ct.webp", expect.any(Buffer), expect.objectContaining({ contentType: "image/webp" }));
  });

  it("imagem acima de 2 MB: não sobe e marca a tentativa", async () => {
    const { db, upload } = makeDb();
    downloadImage.mockResolvedValue({ buffer: Buffer.alloc(2 * 1024 * 1024 + 1), contentType: "image/jpeg" });
    expect(await fetchContactProfilePicture(db, job, { fetchPictureUrl, downloadImage })).toEqual({ ok: true, stored: false });
    expect(upload).not.toHaveBeenCalled();
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
  });

  it("content-type que não é imagem aceita: não sobe", async () => {
    const { db, upload } = makeDb();
    downloadImage.mockResolvedValue({ buffer: Buffer.from("x"), contentType: "text/html" });
    expect(await fetchContactProfilePicture(db, job, { fetchPictureUrl, downloadImage })).toEqual({ ok: true, stored: false });
    expect(upload).not.toHaveBeenCalled();
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
  });

  it("download nulo: não sobe e marca a tentativa", async () => {
    const { db, upload } = makeDb();
    downloadImage.mockResolvedValue(null);
    expect(await fetchContactProfilePicture(db, job, { fetchPictureUrl, downloadImage })).toEqual({ ok: true, stored: false });
    expect(upload).not.toHaveBeenCalled();
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
  });

  it("fetchPictureUrl lança: ok:false e a tentativa é marcada mesmo assim", async () => {
    fetchPictureUrl.mockRejectedValue(new Error("Evolution 500"));
    const { db } = makeDb();
    const r = await fetchContactProfilePicture(db, job, { fetchPictureUrl, downloadImage });
    expect(r).toEqual({ ok: false, reason: "Evolution 500" });
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
  });

  it("erro no upload: ok:false e tentativa marcada", async () => {
    const { db, upload } = makeDb();
    upload.mockResolvedValue({ error: { message: "storage down" } });
    const r = await fetchContactProfilePicture(db, job, { fetchPictureUrl, downloadImage });
    expect(r).toEqual({ ok: false, reason: "storage down" });
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
    expect(m.setContactProfilePicture).not.toHaveBeenCalledWith(db, "ct", "org/ct.jpg");
  });
});

describe("fetchContactProfilePicture com fetch global (defaults)", () => {
  const fetchMock = vi.fn();
  const evolutionResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const imageResponse = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "image/jpeg" }, status = 200) =>
    new Response(body, { status, headers });

  beforeEach(() => {
    vi.clearAllMocks();
    m.getInstanceById.mockResolvedValue({ instance_name: "minha-instancia" });
    m.setContactProfilePicture.mockResolvedValue(undefined);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("URL http:// nao e baixada", async () => {
    fetchMock.mockResolvedValueOnce(evolutionResponse({ profilePictureUrl: "http://pps.whatsapp.net/x.jpg" }));
    const { db, upload } = makeDb();
    expect(await fetchContactProfilePicture(db, job)).toEqual({ ok: true, stored: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
  });

  it("redirecionamento 302 vira foto oculta e nao e seguido", async () => {
    fetchMock
      .mockResolvedValueOnce(evolutionResponse({ profilePictureUrl: "https://pps.whatsapp.net/x.jpg" }))
      .mockResolvedValueOnce(imageResponse(null, { location: "http://interno/x" }, 302));
    const { db, upload } = makeDb();
    expect(await fetchContactProfilePicture(db, job)).toEqual({ ok: true, stored: false });
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ redirect: "manual" });
    expect(upload).not.toHaveBeenCalled();
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
  });

  it("erro de rede no download: ok:false e tentativa marcada (BullMQ repete)", async () => {
    fetchMock
      .mockResolvedValueOnce(evolutionResponse({ profilePictureUrl: "https://pps.whatsapp.net/x.jpg" }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const { db } = makeDb();
    expect(await fetchContactProfilePicture(db, job)).toEqual({ ok: false, reason: "fetch failed" });
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);
  });

  it("corpo em chunks acima de 2 MB (sem content-length) e abortado", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 5) controller.enqueue(chunk);
        else controller.close();
      },
    });
    fetchMock
      .mockResolvedValueOnce(evolutionResponse({ profilePictureUrl: "https://pps.whatsapp.net/x.jpg" }))
      .mockResolvedValueOnce(imageResponse(body));
    const { db, upload } = makeDb();
    expect(await fetchContactProfilePicture(db, job)).toEqual({ ok: true, stored: false });
    expect(sent).toBeLessThan(5);
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(["profilePicUrl", "url"])("fallback do campo %s na resposta da Evolution", async (field) => {
    fetchMock
      .mockResolvedValueOnce(evolutionResponse({ [field]: "https://pps.whatsapp.net/y.jpg" }))
      .mockResolvedValueOnce(imageResponse("img"));
    const { db, upload } = makeDb();
    expect(await fetchContactProfilePicture(db, job)).toEqual({ ok: true, stored: true });
    expect(fetchMock.mock.calls[1]![0].toString()).toBe("https://pps.whatsapp.net/y.jpg");
    expect(upload).toHaveBeenCalled();
  });

  it("5xx no download: ok:false e tentativa marcada; 4xx continua foto oculta", async () => {
    fetchMock
      .mockResolvedValueOnce(evolutionResponse({ profilePictureUrl: "https://pps.whatsapp.net/x.jpg" }))
      .mockResolvedValueOnce(imageResponse(null, {}, 503));
    const { db } = makeDb();
    const r = await fetchContactProfilePicture(db, job);
    expect(r.ok).toBe(false);
    expect(m.setContactProfilePicture).toHaveBeenCalledWith(db, "ct", null);

    fetchMock
      .mockResolvedValueOnce(evolutionResponse({ profilePictureUrl: "https://pps.whatsapp.net/x.jpg" }))
      .mockResolvedValueOnce(imageResponse(null, {}, 404));
    expect(await fetchContactProfilePicture(db, job)).toEqual({ ok: true, stored: false });
  });
});
