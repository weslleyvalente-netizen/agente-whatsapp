import type { FastifyInstance } from "fastify";
import { publishAgentConfigSchema } from "@aula-agente/shared";
import { getAdminClient, getAgentById } from "@aula-agente/database";
import { publishDraft } from "../../services/agent-config.service.js";
import { authMiddleware } from "../../middleware/auth.js";

export default async function agentConfigRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { agentId: string } }>("/agents/:agentId/config/publish", async (request, reply) => {
    const parseResult = publishAgentConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const version = await publishDraft(db, request.params.agentId, parseResult.data.changelog, request.user.id);
    return reply.status(201).send(version);
  });
}
