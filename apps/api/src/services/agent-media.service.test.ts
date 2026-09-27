import { describe, it, expect, vi } from "vitest";
import { detectImageExt, uploadAgentImage, InvalidImageError, MAX_AGENT_IMAGE_BYTES } from "./agent-media.service.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
const PDF = Buffer.from("%PDF-1.7 fake");

function fakeDb(uploadError: unknown = null) {
  const upload = vi.fn().mockResolvedValue({ error: uploadError });
  const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://x.test/public/agent-media/${path}` } }));
  const from = vi.fn(() => ({ upload, getPublicUrl }));
  return { db: { storage: { from } } as never, upload, from };
}

describe("detectImageExt", () => {
  it("detects by file signature, not by name", () => {
    expect(detectImageExt(PNG)).toBe("png");
    expect(detectImageExt(JPG)).toBe("jpg");
    expect(detectImageExt(WEBP)).toBe("webp");
    expect(detectImageExt(PDF)).toBeNull();
  });
});

describe("uploadAgentImage", () => {
  it("stores under org/agent/uuid.ext in agent-media and returns the public URL", async () => {
    const { db, upload, from } = fakeDb();
    const result = await uploadAgentImage(db, { organizationId: "org-1", agentId: "agent-1", file: PNG });

    expect(from).toHaveBeenCalledWith("agent-media");
    expect(result.storage_path).toMatch(/^org-1\/agent-1\/[0-9a-f-]{36}\.png$/);
    expect(result.id).toBe(result.storage_path.split("/")[2].replace(".png", ""));
    expect(result.url).toBe(`https://x.test/public/agent-media/${result.storage_path}`);
    expect(upload).toHaveBeenCalledWith(result.storage_path, PNG, { contentType: "image/png", upsert: false });
  });

  it("rejects a non-image even if it would be named .png", async () => {
    const { db, upload } = fakeDb();
    await expect(uploadAgentImage(db, { organizationId: "o", agentId: "a", file: PDF })).rejects.toBeInstanceOf(InvalidImageError);
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects files over 5 MB", async () => {
    const { db } = fakeDb();
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_AGENT_IMAGE_BYTES)]);
    await expect(uploadAgentImage(db, { organizationId: "o", agentId: "a", file: big })).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("propagates storage errors", async () => {
    const { db } = fakeDb(new Error("bucket not found"));
    await expect(uploadAgentImage(db, { organizationId: "o", agentId: "a", file: PNG })).rejects.toThrow("bucket not found");
  });
});
