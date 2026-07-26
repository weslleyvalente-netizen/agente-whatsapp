import type { FastifyInstance } from "fastify";
import { updateAgentConfigSchema, publishAgentConfigSchema } from "@aula-agente/shared";
import { getAdminClient, getAgentById, patchAgentConfig, createPlaygroundSession, getPlaygroundMessages, getPlaygroundSessionById } from "@aula-agente/database";
import { publishDraft, getAgentConfigWithStatus, discardDraft } from "../../services/agent-config.service.js";
import { sendPlaygroundMessage } from "../../services/playground.service.js";
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

  app.post<{ Params: { agentId: string } }>("/agents/:agentId/playground/sessions", async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const session = await createPlaygroundSession(db, {
      agentId: request.params.agentId,
      organizationId: agent.organization_id,
      createdBy: request.user.id,
    });
    return reply.status(201).send(session);
  });

  app.post<{ Params: { agentId: string; sessionId: string }; Body: { content: string } }>(
    "/agents/:agentId/playground/sessions/:sessionId/messages",
    async (request, reply) => {
      const { content } = request.body ?? {};
      if (!content || typeof content !== "string") {
        return reply.status(400).send({ error: "content is required" });
      }

      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const session = await getPlaygroundSessionById(db, request.params.sessionId);
      if (session.agent_id !== request.params.agentId) {
        return reply.status(403).send({ error: "Session does not belong to this agent" });
      }

      const message = await sendPlaygroundMessage(db, {
        agentId: request.params.agentId,
        organizationId: agent.organization_id,
        sessionId: request.params.sessionId,
        content,
      });
      return reply.status(201).send(message);
    }
  );

  app.get<{ Params: { agentId: string; sessionId: string } }>(
    "/agents/:agentId/playground/sessions/:sessionId/messages",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const session = await getPlaygroundSessionById(db, request.params.sessionId);
      if (session.agent_id !== request.params.agentId) {
        return reply.status(403).send({ error: "Session does not belong to this agent" });
      }

      return getPlaygroundMessages(db, request.params.sessionId);
    }
  );

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

  app.post<{ Params: { agentId: string } }>("/agents/:agentId/config/discard", async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    try {
      const draft = await discardDraft(db, request.params.agentId);
      return draft;
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }
  });
}
