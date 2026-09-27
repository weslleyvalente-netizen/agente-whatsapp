import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@aula-agente/database";

export const AGENT_MEDIA_BUCKET = "agent-media";
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;

export type AgentImageExt = "png" | "jpg" | "webp";

const CONTENT_TYPES: Record<AgentImageExt, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export class InvalidImageError extends Error {}

// Checked by content signature, not by file name or the browser-supplied
// MIME type, so a renamed PDF can't end up being sent to customers.
export function detectImageExt(buf: Buffer): AgentImageExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

export async function uploadAgentImage(
  db: SupabaseClient,
  params: { organizationId: string; agentId: string; file: Buffer }
): Promise<{ id: string; url: string; storage_path: string }> {
  if (params.file.length > MAX_AGENT_IMAGE_BYTES) {
    throw new InvalidImageError("Imagem acima de 5 MB.");
  }
  const ext = detectImageExt(params.file);
  if (!ext) {
    throw new InvalidImageError("Formato não suportado: envie PNG, JPG ou WebP.");
  }

  const id = randomUUID();
  const storagePath = `${params.organizationId}/${params.agentId}/${id}.${ext}`;
  const bucket = db.storage.from(AGENT_MEDIA_BUCKET);
  const { error } = await bucket.upload(storagePath, params.file, { contentType: CONTENT_TYPES[ext], upsert: false });
  if (error) throw error;

  return { id, url: bucket.getPublicUrl(storagePath).data.publicUrl, storage_path: storagePath };
}
