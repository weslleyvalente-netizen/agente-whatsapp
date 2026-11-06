import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { SELLER_AUDIO_MAX_BYTES, SELLER_AUDIO_MAX_SECONDS, detectSellerAudioFormat } from "@aula-agente/shared";
import { getAdminClient, getConversationById, getOrganizationById } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { canViewLead } from "../../lib/lead-access.js";
import { sendPanelMessage } from "../../services/message-send.service.js";
import { releaseSellerAudioSlot, takeSellerAudioSlot } from "./send-audio-limit.js";

const ALLOWED_MIME = new Set(["audio/webm", "audio/mp4", "audio/ogg"]);
const conversationIdSchema = z.string().uuid();

function fieldValue(fields: Record<string, unknown> | undefined, name: string): string | undefined {
  const field = fields?.[name] as { value?: unknown } | undefined;
  return typeof field?.value === "string" ? field.value : undefined;
}

// O cliente envia conversation_id (e duration_seconds) ANTES do arquivo no multipart.
export default async function messageSendAudioRoutes(app: FastifyInstance) {
  app.register(multipart, { limits: { fileSize: SELLER_AUDIO_MAX_BYTES, files: 1 } });

  app.post("/messages/send-audio", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: "Nenhum arquivo de áudio enviado." });

      // Libera o stream sempre que respondemos sem ler o arquivo.
      const reject = (status: number, error: string) => {
        data.file.resume();
        return reply.status(status).send({ error });
      };

      const conversationId = conversationIdSchema.safeParse(fieldValue(data.fields, "conversation_id"));
      if (!conversationId.success) return reject(400, "Conversa inválida.");

      const db = getAdminClient();
      const conversation = await getConversationById(db, conversationId.data);
      if (!conversation) return reject(404, "Conversa não encontrada");

      const membership = request.user.memberships.find((m) => m.organization_id === conversation.organization_id);
      if (!membership) return reject(403, "Access denied");

      const org = await getOrganizationById(db, conversation.organization_id);
      if (org.settings?.seller_audio_enabled !== true) return reject(404, "Envio de áudio não está habilitado");

      if (!(await canViewLead(db, conversation.organization_id, membership.role, request.user.id, conversation.assigned_to))) {
        return reject(403, "Este lead pertence a outro vendedor");
      }

      if (!ALLOWED_MIME.has(data.mimetype.split(";")[0].trim().toLowerCase())) {
        return reject(400, "Formato de áudio não suportado.");
      }

      const durationRaw = fieldValue(data.fields, "duration_seconds");
      let durationSeconds: number | undefined;
      if (durationRaw !== undefined) {
        const n = Number(durationRaw);
        if (Number.isFinite(n) && n > 0 && n <= SELLER_AUDIO_MAX_SECONDS) durationSeconds = Math.round(n);
      }

      const slotKey = `${conversation.organization_id}:${request.user.id}`;
      if (!takeSellerAudioSlot(slotKey)) {
        return reject(429, "Limite de áudios por hora atingido. Tente novamente mais tarde.");
      }

      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch (err) {
        releaseSellerAudioSlot(slotKey);
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.status(413).send({ error: "Áudio acima de 3 MB." });
        }
        throw err;
      }
      if (data.file.truncated) {
        releaseSellerAudioSlot(slotKey);
        return reply.status(413).send({ error: "Áudio acima de 3 MB." });
      }
      if (buffer.length === 0) {
        releaseSellerAudioSlot(slotKey);
        return reply.status(400).send({ error: "Arquivo de áudio vazio." });
      }
      const format = detectSellerAudioFormat(buffer);
      if (!format) {
        releaseSellerAudioSlot(slotKey);
        return reply.status(400).send({ error: "Formato de áudio não suportado." });
      }

      let result;
      try {
        result = await sendPanelMessage({
          conversation,
          content: "[audio]",
          actorUserId: request.user.id,
          audio: { buffer, extension: format.extension, durationSeconds },
        });
      } catch (err) {
        releaseSellerAudioSlot(slotKey);
        console.error(`Failed to send seller audio for conversation ${conversation.id}:`, err);
        return reply.status(500).send({ error: "Não foi possível enviar o áudio." });
      }

      return reply.status(200).send({ ok: true, messageId: result.message.id });
    },
  });
}
