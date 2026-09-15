import type { FastifyInstance } from "fastify";
import { normalizeWixLead, wixLeadWebhookSchema } from "@aula-agente/shared";
import { getAdminClient } from "@aula-agente/database";
import { webhookVerifyMiddleware } from "../../middleware/webhook-verify.js";
import { ingestWixLead } from "../../services/lead-intake.service.js";

// The Wix Automation's "Send HTTP request" action has a legacy "nest
// request body under data" setting that isn't exposed as a toggle in the
// current Automations editor, but is still active for this automation
// (confirmed live: every real submission's body arrives as
// `{ data: { name, phone, ... } }`, not flat). Unwrap it here rather than
// depend on a Wix-side setting we can't see or change, so the webhook works
// regardless of how that setting drifts.
export function unwrapWixLeadBody(rawBody: unknown): unknown {
  const body = rawBody as Record<string, unknown> | null | undefined;
  if (body && typeof body.data === "object" && body.data !== null) {
    return body.data;
  }
  return rawBody;
}

export default async function wixLeadWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/wix-lead", {
    preHandler: [webhookVerifyMiddleware],
    handler: async (request, reply) => {
      const parseResult = wixLeadWebhookSchema.safeParse(unwrapWixLeadBody(request.body));
      if (!parseResult.success) {
        request.log.warn(
          { errors: parseResult.error.issues, body: request.body },
          "Invalid wix-lead payload"
        );
        return reply.status(400).send({ error: "Invalid payload" });
      }

      const db = getAdminClient();
      const result = await ingestWixLead(db, normalizeWixLead(parseResult.data));
      return reply.status(200).send(result);
    },
  });
}
