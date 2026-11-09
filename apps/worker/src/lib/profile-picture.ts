import type { SupabaseClient } from "@supabase/supabase-js";
import { PROFILE_PICTURE_BUCKET, buildProfilePicturePath } from "@aula-agente/shared";
import { getInstanceById, setContactProfilePicture } from "@aula-agente/database";
import type { FetchProfilePictureJobData } from "@aula-agente/queue";

const PROFILE_PICTURE_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const EXTENSION_BY_CONTENT_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

export type FetchProfilePictureResult = { ok: true; stored: boolean } | { ok: false; reason: string };

export interface FetchProfilePictureDeps {
  fetchPictureUrl?: (instanceName: string, phone: string) => Promise<string | null>;
  downloadImage?: (url: string) => Promise<{ buffer: Buffer; contentType: string } | null>;
}

function pickUrl(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["profilePictureUrl", "profilePicUrl", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

// O formato da resposta da Evolution é lido de forma defensiva (ver relatório): nulo/ausente = foto oculta.
const defaultFetchPictureUrl = async (instanceName: string, phone: string): Promise<string | null> => {
  const response = await fetch(`${process.env.EVOLUTION_API_URL}/chat/fetchProfilePictureUrl/${instanceName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY ?? "" },
    body: JSON.stringify({ number: phone }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Evolution profile picture fetch error ${response.status}`);
  return pickUrl(await response.json().catch(() => null));
};

const defaultDownloadImage = async (url: string): Promise<{ buffer: Buffer; contentType: string } | null> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PROFILE_PICTURE_MAX_BYTES) return null;
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(contentType in EXTENSION_BY_CONTENT_TYPE)) return null;
  return { buffer: Buffer.from(await response.arrayBuffer()), contentType };
};

/**
 * Busca a foto de perfil do contato na Evolution e guarda no bucket privado.
 * Sempre marca a tentativa (setContactProfilePicture) para o webhook não reenfileirar a cada mensagem;
 * erros devolvem ok:false (o job lança e o BullMQ tenta de novo), nunca lançam daqui.
 */
export async function fetchContactProfilePicture(
  db: SupabaseClient,
  input: FetchProfilePictureJobData,
  deps: FetchProfilePictureDeps = {}
): Promise<FetchProfilePictureResult> {
  const fetchPictureUrl = deps.fetchPictureUrl ?? defaultFetchPictureUrl;
  const downloadImage = deps.downloadImage ?? defaultDownloadImage;

  let stored: string | null = null;
  let failure: string | null = null;
  try {
    const instance = await getInstanceById(db, input.instanceId);
    const url = await fetchPictureUrl(instance.instance_name, input.phone);
    const image = url ? await downloadImage(url) : null;
    const extension = image ? EXTENSION_BY_CONTENT_TYPE[image.contentType as keyof typeof EXTENSION_BY_CONTENT_TYPE] : undefined;
    if (image && extension && image.buffer.length > 0 && image.buffer.length <= PROFILE_PICTURE_MAX_BYTES) {
      const path = buildProfilePicturePath({ organizationId: input.organizationId, contactId: input.contactId, extension });
      const { error } = await db.storage
        .from(PROFILE_PICTURE_BUCKET)
        .upload(path, image.buffer, { contentType: image.contentType, upsert: true });
      if (error) failure = error.message;
      else stored = path;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : "unknown_error";
  }

  try {
    await setContactProfilePicture(db, input.contactId, stored);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unknown_error" };
  }
  if (failure !== null) return { ok: false, reason: failure };
  return { ok: true, stored: stored !== null };
}
