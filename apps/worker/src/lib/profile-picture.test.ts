import { beforeEach, describe, expect, it, vi } from "vitest";
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
