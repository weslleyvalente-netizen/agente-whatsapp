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
    // Evolution sends an explicit `null` (not just an absent key) for these
    // whenever a message has no content body or no ad context — .optional()
    // alone only tolerates a missing key, not null, and rejects the entire
    // webhook with 400 when it shows up. Verified live: a real customer's
    // first message from a Click-to-WhatsApp ad was dropped this way
    // (contextInfo: null), silently losing the lead — the agent never saw it.
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
    }).passthrough().nullable().optional(),
    // Click-to-WhatsApp ads (Meta/Instagram) attach the ad's title/body here
    // — a sibling of `message`, not nested inside it. See extractAdContextPrefix
    // in apps/api/src/routes/webhooks/evolution.ts for how this gets surfaced
    // to the agent.
    contextInfo: z.object({
      externalAdReply: z.object({
        title: z.string().optional(),
        body: z.string().optional(),
      }).passthrough().optional(),
    }).passthrough().nullable().optional(),
    messageType: z.string(),
    pushName: z.string().nullable().optional(),
    messageTimestamp: z.number().optional(),
  }),
});
