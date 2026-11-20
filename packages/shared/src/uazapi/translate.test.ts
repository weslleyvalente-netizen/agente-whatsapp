import { describe, expect, it } from "vitest";
import { describeShape, translateUazapiEvent } from "./translate.js";
import { evolutionWebhookPayloadSchema } from "../schemas/evolution.js";
import { parseEvolutionStatusUpdate } from "../evolution-status.js";

const base = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  EventType: "messages", owner: "5562900000000", token: "tok", BaseUrl: "https://x.uazapi.com", instanceName: "weslley",
  message: {
    id: "5562900000000:MSG1", messageid: "MSG1", chatid: "5562999990000@s.whatsapp.net", sender: "5562999990000@s.whatsapp.net",
    senderName: "Cliente", fromMe: false, isGroup: false, messageType: "Conversation", text: "Olá", messageTimestamp: 1788868800000,
    ...message,
  },
  ...extra,
});
const msg = (body: unknown) => {
  const t = translateUazapiEvent(body, "inst-1");
  if (t.kind !== "message") throw new Error(`esperava message, veio ${t.kind}`);
  return t;
};

describe("translateUazapiEvent: mensagens", () => {
  it("texto: conversation, timestamp em segundos, id do WhatsApp e formato aceito pelo schema", () => {
    const t = msg(base({}));
    expect(t.payload).toMatchObject({ event: "messages.upsert", instance: "inst-1" });
    expect(t.payload.data.message?.conversation).toBe("Olá");
    expect(t.payload.data.messageTimestamp).toBe(1788868800);
    expect(t.payload.data.key).toMatchObject({ id: "MSG1", fromMe: false, remoteJid: "5562999990000@s.whatsapp.net" });
    expect(t.payload.data.pushName).toBe("Cliente");
    expect(t.recognized).toBe(true);
    expect(evolutionWebhookPayloadSchema.safeParse(t.payload).success).toBe(true);
  });

  it("timestamp que já vem em segundos não é dividido de novo", () => {
    expect(msg(base({ messageTimestamp: 1788868800 })).payload.data.messageTimestamp).toBe(1788868800);
  });

  it("ExtendedTextMessage também vira conversation", () => {
    const t = msg(base({ messageType: "ExtendedTextMessage", text: "link aqui" }));
    expect(t.payload.data.messageType).toBe("conversation");
    expect(t.payload.data.message?.conversation).toBe("link aqui");
  });

  it("@lid recebido: remoteJidAlt = sender_pn", () => {
    const t = msg(base({ chatid: "85801266339926@lid", sender_pn: "5562999990000@s.whatsapp.net" }));
    expect(t.payload.data.key.remoteJidAlt).toBe("5562999990000@s.whatsapp.net");
  });

  it("@lid fromMe: remoteJidAlt = chat.wa_chatid", () => {
    const t = msg(base({ chatid: "85801266339926@lid", fromMe: true, sender_pn: "5562900000000@s.whatsapp.net" }, { chat: { wa_chatid: "5562999990000@s.whatsapp.net" } }));
    expect(t.payload.data.key.remoteJidAlt).toBe("5562999990000@s.whatsapp.net");
  });

  it("número comum não ganha remoteJidAlt", () => {
    expect(msg(base({})).payload.data.key.remoteJidAlt ?? null).toBeNull();
  });

  it("eco do envio pela API preserva fromMe e o id", () => {
    const t = msg(base({ fromMe: true, wasSentByApi: true, messageid: "3EB0ABC" }));
    expect(t.payload.data.key).toMatchObject({ fromMe: true, id: "3EB0ABC" });
  });

  it("imagem com legenda em text", () => {
    const t = msg(base({ messageType: "ImageMessage", text: "foto da moto", content: { URL: "https://x", mimetype: "image/jpeg" } }));
    expect(t.payload.data.messageType).toBe("imageMessage");
    expect((t.payload.data.message as any).imageMessage.caption).toBe("foto da moto");
  });

  it("áudio: segundos e tamanho vindos de content (chaves maiúsculas)", () => {
    const t = msg(base({ messageType: "AudioMessage", text: "", content: { Seconds: 7, FileLength: "12345" } }));
    const audio = (t.payload.data.message as any).audioMessage;
    expect(audio.seconds).toBe(7);
    expect(audio.fileLength).toBe("12345");
  });

  it("documento: nome do arquivo", () => {
    const t = msg(base({ messageType: "DocumentMessage", text: "", content: { fileName: "rg.pdf" } }));
    expect((t.payload.data.message as any).documentMessage.fileName).toBe("rg.pdf");
  });

  it("documento com legenda vira documentMessage", () => {
    const t = msg(base({ messageType: "DocumentWithCaptionMessage", text: "segue", content: { title: "cnh.pdf" } }));
    expect(t.payload.data.messageType).toBe("documentMessage");
    expect((t.payload.data.message as any).documentMessage).toMatchObject({ fileName: "cnh.pdf", caption: "segue" });
  });

  it("anúncio: externalAdReply levado para contextInfo", () => {
    const t = msg(base({ content: { ContextInfo: { ExternalAdReply: { Title: "Fazer 250", Body: "Condição" } } } }));
    expect(t.payload.data.contextInfo?.externalAdReply).toMatchObject({ title: "Fazer 250", body: "Condição" });
  });

  it("tipo desconhecido passa com o tipo original e recognized=false", () => {
    const t = msg(base({ messageType: "PollCreationMessage" }));
    expect(t.recognized).toBe(false);
    expect(t.payload.data.messageType).toBe("pollCreationMessage");
    expect(evolutionWebhookPayloadSchema.safeParse(t.payload).success).toBe(true);
  });

  it("reação passa como reactionMessage (o handler ignora)", () => {
    expect(msg(base({ messageType: "ReactionMessage" })).payload.data.messageType).toBe("reactionMessage");
  });

  it("grupo é ignorado", () => {
    expect(translateUazapiEvent(base({ isGroup: true, chatid: "123@g.us" }), "inst-1")).toEqual({ kind: "ignored", reason: "group" });
  });

  it("corpo sem message é inválido", () => {
    expect(translateUazapiEvent({ EventType: "messages" }, "inst-1")).toEqual({ kind: "ignored", reason: "invalid" });
    expect(translateUazapiEvent(null, "inst-1")).toEqual({ kind: "ignored", reason: "invalid" });
  });
});

describe("translateUazapiEvent: status e conexão", () => {
  it("ReadReceipt Read com dois ids vira dois eventos READ lidos pelo parser atual", () => {
    const t = translateUazapiEvent({ EventType: "messages_update", type: "ReadReceipt", state: "Read", event: { MessageIDs: ["A1", "A2"], Timestamp: 1788868800, IsFromMe: false } }, "inst-1");
    if (t.kind !== "status") throw new Error(t.kind);
    expect(t.events).toHaveLength(2);
    expect(t.events.map((e) => parseEvolutionStatusUpdate(e))).toEqual([
      { instance: "inst-1", messageId: "A1", status: "read" },
      { instance: "inst-1", messageId: "A2", status: "read" },
    ]);
  });

  it("Delivered vira DELIVERY_ACK; estado desconhecido é ignorado", () => {
    const t = translateUazapiEvent({ EventType: "messages_update", type: "ReadReceipt", state: "Delivered", event: { MessageIDs: ["A1"] } }, "inst-1");
    expect(t.kind === "status" && t.events[0].data.status).toBe("DELIVERY_ACK");
    expect(translateUazapiEvent({ EventType: "messages_update", type: "ReadReceipt", state: "Pinned", event: { MessageIDs: ["A1"] } }, "inst-1").kind).toBe("ignored");
    expect(translateUazapiEvent({ EventType: "messages_update", type: "GroupReceipts", event: {} }, "inst-1").kind).toBe("ignored");
  });

  it("connection", () => {
    expect(translateUazapiEvent({ EventType: "connection", instance: { status: "disconnected" } }, "inst-1")).toEqual({ kind: "connection", status: "disconnected" });
  });

  it("outros eventos são ignorados", () => {
    expect(translateUazapiEvent({ EventType: "presence" }, "inst-1")).toEqual({ kind: "ignored", reason: "unsupported_event" });
  });
});

describe("describeShape", () => {
  it("só chaves e tipos, nunca valores", () => {
    const value = { a: "segredo", b: { c: 1 }, d: [true], e: null };
    const shape = describeShape(value);
    expect(shape).toEqual({ a: "string", b: { c: "number" }, d: ["boolean"], e: "null" });
    expect(JSON.stringify(shape)).not.toContain("segredo");
  });

  it("corta na profundidade", () => {
    expect(describeShape({ a: { b: { c: { d: 1 } } } }, 2)).toEqual({ a: { b: "object" } });
  });
});
