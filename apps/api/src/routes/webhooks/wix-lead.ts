import type { FastifyInstance } from "fastify";
import { normalizeWixLead, wixLeadWebhookSchema } from "@aula-agente/shared";
import { getAdminClient } from "@aula-agente/database";
import { webhookVerifyMiddleware } from "../../middleware/webhook-verify.js";
import { ingestWixLead } from "../../services/lead-intake.service.js";

export default async function wixLeadWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/wix-lead", {
    preHandler: [webhookVerifyMiddleware],
    handler: async (request, reply) => {
      const parseResult = wixLeadWebhookSchema.safeParse(request.body);
      if (!parseResult.success) {
        request.log.warn({ errors: parseResult.error.issues }, "Invalid wix-lead payload");
        return reply.status(400).send({ error: "Invalid payload" });
      }

      const db = getAdminClient();
      const result = await ingestWixLead(db, normalizeWixLead(parseResult.data));
      return reply.status(200).send(result);
    },
  });
}
