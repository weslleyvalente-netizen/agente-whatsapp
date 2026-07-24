import { z } from "zod";

export const createInstanceSchema = z.object({
  instance_name: z.string().min(1).max(100),
});

export const updateInstanceSchema = z.object({
  active_agent_id: z.string().uuid().nullable().optional(),
});

export const evolutionWebhookPayloadSchema = z.object({
  event: z.string(),
  instance: z.string(),
  data: z.object({
    key: z.object({
      remoteJid: z.string(),
      fromMe: z.boolean(),
      id: z.string(),
    }),
    message: z.object({
      conversation: z.string().optional(),
      imageMessage: z.object({ caption: z.string().optional() }).optional(),
      audioMessage: z.object({ seconds: z.number().optional() }).passthrough().optional(),
      videoMessage: z.object({ caption: z.string().optional() }).optional(),
      documentMessage: z.object({ fileName: z.string().optional() }).optional(),
      stickerMessage: z.object({}).optional(),
      locationMessage: z.object({
        degreesLatitude: z.number().optional(),
        degreesLongitude: z.number().optional(),
      }).optional(),
    }).passthrough().optional(),
    messageType: z.string(),
    pushName: z.string().nullable().optional(),
    messageTimestamp: z.number().optional(),
  }),
});
