// Cliente da UAZAPI (uazapiGO v3). Cabeçalho `token` (instância) ou `admintoken` (administração; só no servidor).
// Base: UAZAPI_BASE_URL (ex.: https://motoetrilha.uazapi.com). Respostas de envio voltam no formato da Evolution ({ key: { id } })
// para o worker continuar gravando evolution_message_id do mesmo jeito.
import { EvolutionMediaTooLargeError } from "./media-errors.js";

export class UazapiHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`UAZAPI error ${status}: ${body}`);
    this.name = "UazapiHttpError";
  }
}

export type UazapiConnectionInfo = { status: string; qrcode: string | null; paircode: string | null };
type Auth = { token: string } | { admintoken: string };

const MAX_RETRY_AFTER_S = 5;

function baseUrl(): string {
  const url = process.env.UAZAPI_BASE_URL;
  if (!url) throw new Error("UAZAPI_BASE_URL não configurado");
  return url.replace(/\/+$/, "");
}

async function uazapiFetch(path: string, auth: Auth, init: { method?: string; body?: unknown; signal?: AbortSignal; acceptStatus?: number[] } = {}): Promise<{ status: number; data: any }> {
  const doFetch = () => fetch(`${baseUrl()}${path}`, {
    method: init.method ?? "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...auth },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: init.signal,
  });
  let response = await doFetch();
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const parsed = header === null ? NaN : Number(header);
    const wait = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), MAX_RETRY_AFTER_S) : 1;
    await new Promise((r) => setTimeout(r, wait * 1000));
    response = await doFetch();
  }
  if (!response.ok && !init.acceptStatus?.includes(response.status)) {
    throw new UazapiHttpError(response.status, await response.text().catch(() => ""));
  }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

const asSent = (data: any) => ({ key: { id: typeof data?.messageid === "string" && data.messageid ? data.messageid : null } });

export async function uazapiSendText(token: string, phone: string, text: string, signal?: AbortSignal): Promise<{ key: { id: string | null } }> {
  return asSent((await uazapiFetch("/send/text", { token }, { body: { number: phone, text }, signal })).data);
}

export async function uazapiSendMedia(
  token: string,
  phone: string,
  media: { type: "image" | "video" | "document" | "ptt"; file: string; caption?: string; docName?: string; mimetype?: string }
): Promise<{ key: { id: string | null } }> {
  const body: Record<string, unknown> = { number: phone, type: media.type, file: media.file };
  if (media.caption) body.text = media.caption;
  if (media.docName) body.docName = media.docName;
  if (media.mimetype) body.mimetype = media.mimetype;
  return asSent((await uazapiFetch("/send/media", { token }, { body })).data);
}

async function readCapped(response: Response, maxBytes: number | undefined): Promise<Buffer> {
  if (maxBytes === undefined || !response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new EvolutionMediaTooLargeError(total);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function uazapiDownloadMedia(
  token: string,
  messageId: string,
  opts: { timeoutMs: number; maxBytes?: number; mp3?: boolean }
): Promise<{ base64: string; mimetype: string }> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const { data } = await uazapiFetch("/message/download", { token }, { body: { id: messageId, generate_mp3: opts.mp3 ?? false, return_link: true }, signal });
  const fileURL = typeof data?.fileURL === "string" ? data.fileURL : "";
  if (!fileURL) throw new Error("UAZAPI media download: sem fileURL");
  const file = await fetch(fileURL, { signal });
  if (!file.ok) throw new Error(`UAZAPI media file error ${file.status}`);
  if (opts.maxBytes !== undefined) {
    const declared = Number(file.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await file.body?.cancel().catch(() => undefined);
      throw new EvolutionMediaTooLargeError(declared);
    }
  }
  const buffer = await readCapped(file, opts.maxBytes);
  const mimetype = typeof data?.mimetype === "string" && data.mimetype ? data.mimetype : file.headers.get("content-type") ?? "application/octet-stream";
  return { base64: buffer.toString("base64"), mimetype };
}

export async function uazapiAvatarUrl(token: string, phone: string): Promise<string | null> {
  const { data } = await uazapiFetch("/chat/avatar", { token }, { body: { number: phone, preview: true }, signal: AbortSignal.timeout(10_000) });
  return typeof data?.url === "string" && data.url.trim() ? data.url.trim() : null;
}

export async function uazapiCreateInstance(name: string): Promise<{ token: string }> {
  const admintoken = process.env.UAZAPI_ADMIN_TOKEN;
  if (!admintoken) throw new Error("UAZAPI_ADMIN_TOKEN não configurado");
  const { data } = await uazapiFetch("/instance/create", { admintoken }, { body: { name } });
  const token = typeof data?.token === "string" && data.token ? data.token : data?.instance?.token;
  if (typeof token !== "string" || !token) throw new Error("UAZAPI /instance/create sem token na resposta");
  return { token };
}

export async function uazapiSetWebhook(token: string, url: string): Promise<void> {
  await uazapiFetch("/webhook", { token }, {
    body: { enabled: true, url, events: ["messages", "messages_update", "connection"], excludeMessages: ["isGroupYes"] },
  });
}

function connectionInfo(data: any): UazapiConnectionInfo {
  const inst = data?.instance ?? {};
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { status: s(inst.status) ?? "disconnected", qrcode: s(inst.qrcode), paircode: s(inst.paircode) };
}

export async function uazapiStatus(token: string): Promise<UazapiConnectionInfo> {
  return connectionInfo((await uazapiFetch("/instance/status", { token }, { method: "GET", signal: AbortSignal.timeout(10_000) })).data);
}

export async function uazapiConnect(token: string, phone?: string): Promise<UazapiConnectionInfo> {
  const { status, data } = await uazapiFetch("/instance/connect", { token }, { body: phone ? { phone } : {}, acceptStatus: [409] });
  // 409: já existe um pareamento em andamento; o estado atual traz o QR/código vigente.
  return status === 409 ? uazapiStatus(token) : connectionInfo(data);
}

/**
 * Mensagens guardadas pela UAZAPI na janela [sinceMs, untilMs] (epoch em ms), de todas as conversas.
 * /message/find devolve do mais novo para o mais antigo (offset 0 = mais recentes); para quando a página passa do início da janela,
 * quando não há mais páginas ou no teto de páginas. Devolve os objetos `message` como vêm (mesmo formato do webhook).
 */
export async function uazapiFindMessages(
  token: string,
  opts: { sinceMs: number; untilMs: number; pageSize?: number; maxPages?: number }
): Promise<Array<Record<string, unknown>>> {
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? 40;
  const out: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const { data } = await uazapiFetch("/message/find", { token }, { body: { limit: pageSize, offset }, signal: AbortSignal.timeout(30_000) });
    const messages: Array<Record<string, unknown>> = Array.isArray(data?.messages) ? data.messages : [];
    let oldest = Infinity;
    for (const m of messages) {
      const ts = Number(m?.messageTimestamp);
      if (!Number.isFinite(ts)) continue;
      const ms = ts > 1e11 ? ts : ts * 1000;
      oldest = Math.min(oldest, ms);
      if (ms >= opts.sinceMs && ms <= opts.untilMs) out.push(m);
    }
    const hasMore = data?.pagination?.hasMore === true && messages.length > 0;
    if (!hasMore || oldest < opts.sinceMs) break;
    offset = typeof data?.pagination?.nextOffset === "number" ? data.pagination.nextOffset : offset + messages.length;
  }
  return out;
}
