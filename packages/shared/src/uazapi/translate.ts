// Tradução dos eventos de webhook da UAZAPI (uazapiGO v3) para o formato interno que a rota da Evolution já valida e processa
// (evolutionWebhookPayloadSchema / parseEvolutionStatusUpdate). Função pura: nada de rede, banco ou log aqui.
// Diferenças de formato que esta camada resolve:
//   - id do WhatsApp em message.messageid (message.id é interno da UAZAPI);
//   - messageTimestamp em MILISSEGUNDOS (o formato interno usa segundos); recibo de leitura (Timestamp) já vem em segundos;
//   - tipos em PascalCase ("ImageMessage"); conteúdo de mídia em message.content, com chaves não documentadas (normalizadas aqui
//     para a primeira letra minúscula, cobrindo tanto "Seconds" quanto "seconds").
import type { z } from "zod";
import type { evolutionWebhookPayloadSchema } from "../schemas/evolution.js";

export type EvolutionLikeMessageEvent = z.infer<typeof evolutionWebhookPayloadSchema>;
export type UazapiStatusEvent = { event: "messages.update"; instance: string; data: { keyId: string; status: "DELIVERY_ACK" | "READ" | "PLAYED" } };

export type UazapiTranslation =
  | { kind: "message"; payload: EvolutionLikeMessageEvent; messageType: string; recognized: boolean }
  | { kind: "status"; events: UazapiStatusEvent[] }
  | { kind: "connection"; status: string | null }
  | { kind: "ignored"; reason: "group" | "unsupported_event" | "invalid" };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

const TEXT_TYPES = new Set(["conversation", "extendedTextMessage"]);
const MEDIA_TYPES = new Set([
  "imageMessage", "videoMessage", "audioMessage", "documentMessage", "documentWithCaptionMessage",
  "stickerMessage", "locationMessage", "reactionMessage", "protocolMessage",
]);
const RECEIPT_STATUS: Record<string, UazapiStatusEvent["data"]["status"]> = { delivered: "DELIVERY_ACK", read: "READ", played: "PLAYED" };

const lowerFirst = (k: string) => (k ? k[0].toLowerCase() + k.slice(1) : k);

/** Normaliza as chaves (recursivo) para a primeira letra minúscula: "ExternalAdReply" -> "externalAdReply". */
function normalizeKeys(v: unknown, depth = 0): unknown {
  if (depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => normalizeKeys(x, depth + 1));
  if (!isRec(v)) return v;
  const out: Rec = {};
  for (const [k, x] of Object.entries(v)) out[lowerFirst(k)] = normalizeKeys(x, depth + 1);
  return out;
}

/** Forma do valor (chaves e tipos), sem nenhum valor original. Para log de diagnóstico. */
export function describeShape(value: unknown, depth = 3): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (depth <= 0) return "array";
    return value.length ? [describeShape(value[0], depth - 1)] : [];
  }
  if (isRec(value)) {
    if (depth <= 0) return "object";
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) out[k] = describeShape(v, depth - 1);
    return out;
  }
  return typeof value;
}

function remoteJidAlt(m: Rec, chat: Rec | undefined, fromMe: boolean): string | null {
  const chatid = str(m.chatid) ?? "";
  if (!chatid.endsWith("@lid")) return null;
  if (!fromMe) return str(m.sender_pn) ?? null;
  const pn = str(chat?.wa_chatid);
  return pn && pn.endsWith("@s.whatsapp.net") ? pn : null;
}

function translateMessage(body: Rec, m: Rec, instanceId: string): UazapiTranslation {
  const chatid = str(m.chatid);
  const messageid = str(m.messageid);
  if (!chatid || !messageid) return { kind: "ignored", reason: "invalid" };
  if (m.isGroup === true || chatid.endsWith("@g.us")) return { kind: "ignored", reason: "group" };

  const fromMe = m.fromMe === true;
  const rawType = str(m.messageType) ?? "unknown";
  const lowered = lowerFirst(rawType);
  const text = typeof m.text === "string" ? m.text : "";
  const content = normalizeKeys(isRec(m.content) ? m.content : {}) as Rec;

  let messageType = lowered;
  let message: Rec;
  let recognized = true;
  if (TEXT_TYPES.has(lowered)) {
    messageType = "conversation";
    message = { conversation: text || str(content.text) || "" };
  } else if (MEDIA_TYPES.has(lowered)) {
    if (lowered === "documentWithCaptionMessage") messageType = "documentMessage";
    const inner: Rec = { ...content };
    delete inner.contextInfo;
    const caption = text || str(content.caption);
    if (caption) inner.caption = caption;
    if (messageType === "audioMessage" && typeof content.seconds !== "number") delete inner.seconds;
    if (messageType === "documentMessage") {
      const fileName = str(content.fileName) ?? str(content.title);
      if (fileName) inner.fileName = fileName;
    }
    message = { [messageType]: inner };
  } else {
    recognized = false;
    message = {};
  }

  const contextInfo = isRec(content.contextInfo) ? content.contextInfo : undefined;
  const externalAdReply = isRec(contextInfo?.externalAdReply) ? contextInfo.externalAdReply : undefined;

  const ms = typeof m.messageTimestamp === "number" ? m.messageTimestamp : Number(m.messageTimestamp);
  const messageTimestamp = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;

  const payload: EvolutionLikeMessageEvent = {
    event: "messages.upsert",
    instance: instanceId,
    data: {
      key: { remoteJid: chatid, remoteJidAlt: remoteJidAlt(m, isRec(body.chat) ? body.chat : undefined, fromMe), fromMe, id: messageid },
      message: message as EvolutionLikeMessageEvent["data"]["message"],
      ...(externalAdReply ? { contextInfo: { externalAdReply } } : {}),
      messageType,
      pushName: str(m.senderName) ?? null,
      ...(messageTimestamp !== undefined ? { messageTimestamp } : {}),
    },
  };
  return { kind: "message", payload, messageType: rawType, recognized };
}

function translateReceipt(body: Rec, instanceId: string): UazapiTranslation {
  if (body.type !== "ReadReceipt") return { kind: "ignored", reason: "unsupported_event" };
  const status = RECEIPT_STATUS[String(body.state ?? "").toLowerCase()];
  const event = isRec(body.event) ? body.event : undefined;
  const ids = Array.isArray(event?.MessageIDs) ? event.MessageIDs.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  if (!status || ids.length === 0) return { kind: "ignored", reason: "unsupported_event" };
  return { kind: "status", events: ids.map((keyId) => ({ event: "messages.update", instance: instanceId, data: { keyId, status } })) };
}

export function translateUazapiEvent(body: unknown, instanceId: string): UazapiTranslation {
  if (!isRec(body)) return { kind: "ignored", reason: "invalid" };
  switch (body.EventType) {
    case "messages":
      return isRec(body.message) ? translateMessage(body, body.message, instanceId) : { kind: "ignored", reason: "invalid" };
    case "messages_update":
      return translateReceipt(body, instanceId);
    case "connection": {
      const inst = isRec(body.instance) ? body.instance : undefined;
      return { kind: "connection", status: str(inst?.status) ?? null };
    }
    case undefined:
      return { kind: "ignored", reason: "invalid" };
    default:
      return { kind: "ignored", reason: "unsupported_event" };
  }
}
