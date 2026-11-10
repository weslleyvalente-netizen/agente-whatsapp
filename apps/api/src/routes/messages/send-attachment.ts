import type { FastifyInstance } from "fastify";
import multipart, { type MultipartFile } from "@fastify/multipart";
import { z } from "zod";
import { CHAT_MEDIA_MAX_BYTES, detectAttachmentFormat, sanitizeDownloadName } from "@aula-agente/shared";
import { getAdminClient, getConversationById, getOrganizationById } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { canViewLead } from "../../lib/lead-access.js";
import { SellerAttachmentSendError, sendPanelMessage } from "../../services/message-send.service.js";
import { releaseAttachmentSlot, takeAttachmentSlot } from "./send-attachment-limit.js";

const conversationIdSchema = z.string().uuid();
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CAPTION_MAX_CHARS = 1000;

function fieldValue(fields: Record<string, unknown> | undefined, name: string): string | undefined {
  const field = fields?.[name] as { value?: unknown } | undefined;
  return typeof field?.value === "string" ? field.value : undefined;
}

// O cliente envia conversation_id (e caption) ANTES do arquivo no multipart.
export default async function messageSendAttachmentRoutes(app: FastifyInstance) {
  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 8 * 1024, parts: 3 } });

  app.post("/messages/send-attachment", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      // Lê as partes em ordem: só valem os campos que chegam ANTES do arquivo.
      const fields: Record<string, { value: unknown }> = {};
      let data: MultipartFile | undefined;
      let wrongFileField = false;
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            // Só o campo "file" é o anexo; qualquer outro arquivo é descartado.
            if (part.fieldname !== "file") {
              part.file.resume();
              wrongFileField = true;
              break;
            }
            data = part;
            break;
          }
          if (part.fieldnameTruncated || part.valueTruncated) {
            return reply.status(413).send({ error: "Campo do formulário grande demais." });
          }
          fields[part.fieldname] = { value: part.value };
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FST_FIELDS_LIMIT" || code === "FST_PARTS_LIMIT" || code === "FST_FILES_LIMIT") {
          return reply.status(400).send({ error: "Formulário inválido: campos demais." });
        }
        throw err;
      }
      if (wrongFileField) return reply.status(400).send({ error: "Nenhum arquivo enviado." });
      if (!data) return reply.status(400).send({ error: "Nenhum arquivo enviado." });

      // Libera o stream sempre que respondemos sem ler o arquivo.
      const reject = (status: number, error: string) => {
        data.file.resume();
        return reply.status(status).send({ error });
      };

      const conversationId = conversationIdSchema.safeParse(fieldValue(fields, "conversation_id"));
      if (!conversationId.success) return reject(400, "Conversa inválida.");

      const db = getAdminClient();
      const conversation = await getConversationById(db, conversationId.data);
      if (!conversation) return reject(404, "Conversa não encontrada");

      const membership = request.user.memberships.find((m) => m.organization_id === conversation.organization_id);
      if (!membership) return reject(403, "Access denied");

      const org = await getOrganizationById(db, conversation.organization_id);
      if (org?.settings?.seller_attachments_enabled !== true) return reject(404, "Envio de anexos não está habilitado");

      if (!(await canViewLead(db, conversation.organization_id, membership.role, request.user.id, conversation.assigned_to))) {
        return reject(403, "Este lead pertence a outro vendedor");
      }

      const captionRaw = fieldValue(fields, "caption")?.trim();
      const caption = captionRaw ? captionRaw : undefined;
      if (caption && Array.from(caption).length > CAPTION_MAX_CHARS) {
        return reject(400, `A legenda deve ter no máximo ${CAPTION_MAX_CHARS} caracteres.`);
      }

      const slotKey = `${conversation.organization_id}:${request.user.id}`;
      if (!takeAttachmentSlot(slotKey)) {
        return reject(429, "Limite de anexos por hora atingido. Tente novamente mais tarde.");
      }

      try {
        let buffer: Buffer;
        try {
          buffer = await data.toBuffer();
        } catch (err) {
          if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
            releaseAttachmentSlot(slotKey);
            return reply.status(413).send({ error: "Arquivo acima do limite" });
          }
          throw err;
        }
        if (data.file.truncated) {
          releaseAttachmentSlot(slotKey);
          return reply.status(413).send({ error: "Arquivo acima do limite" });
        }
        if (buffer.length === 0) {
          releaseAttachmentSlot(slotKey);
          return reply.status(400).send({ error: "Arquivo vazio." });
        }

        // Tipo, mime e extensão vêm só dos bytes; o que o cliente declarou não é considerado.
        const format = detectAttachmentFormat(buffer, data.filename ?? "");
        if (!format) {
          releaseAttachmentSlot(slotKey);
          return reply.status(400).send({ error: "Tipo de arquivo não suportado." });
        }
        const maxBytes = CHAT_MEDIA_MAX_BYTES[format.kind];
        if (buffer.length > maxBytes) {
          releaseAttachmentSlot(slotKey);
          return reply.status(413).send({ error: `Arquivo acima do limite de ${Math.round(maxBytes / (1024 * 1024))} MB.` });
        }

        const fileName = sanitizeDownloadName(data.filename) ?? `anexo.${format.extension}`;

        let result;
        try {
          result = await sendPanelMessage({
            conversation,
            content: caption ?? fileName,
            actorUserId: request.user.id,
            attachment: { buffer, kind: format.kind, mime: format.mime, extension: format.extension, fileName, ...(caption ? { caption } : {}) },
          });
        } catch (err) {
          // Só mantém a vaga quando o arquivo já foi armazenado.
          if (!(err instanceof SellerAttachmentSendError && err.uploaded)) releaseAttachmentSlot(slotKey);
          console.error(`Failed to send seller attachment for conversation ${conversation.id}:`, err);
          return reply.status(500).send({ error: "Não foi possível enviar o anexo." });
        }

        return reply.status(200).send({ ok: true, messageId: result.message.id });
      } catch (err) {
        // Qualquer erro inesperado antes do envio não pode consumir a vaga.
        releaseAttachmentSlot(slotKey);
        throw err;
      }
    },
  });
}
