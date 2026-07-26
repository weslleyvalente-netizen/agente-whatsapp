import type { FastifyInstance } from "fastify";
import { updateAgentConfigSchema, publishAgentConfigSchema } from "@aula-agente/shared";
import { getAdminClient, getAgentById, patchAgentConfig } from "@aula-agente/database";
import { publishDraft, getAgentConfigWithStatus } from "../../services/agent-config.service.js";
import { authMiddleware } from "../../middleware/auth.js";

export default async function agentConfigRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { agentId: string } }>("/agents/:agentId/config", async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return getAgentConfigWithStatus(db, request.params.agentId);
  });

  app.patch<{ Params: { agentId: string } }>("/agents/:agentId/config", async (request, reply) => {
    const parseResult = updateAgentConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const draft = await patchAgentConfig(db, request.params.agentId, parseResult.data, request.user.id);
    return draft;
  });

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
