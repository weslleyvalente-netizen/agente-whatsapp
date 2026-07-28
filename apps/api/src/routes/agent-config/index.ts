import type { FastifyInstance, FastifyReply } from "fastify";
import { updateAgentConfigSchema, publishAgentConfigSchema, sendTrainerMessageSchema } from "@aula-agente/shared";
import {
  getAdminClient, getAgentById, patchAgentConfig,
  createPlaygroundSession, getPlaygroundMessages, getPlaygroundSessionById,
  createTrainerSession, getTrainerSessionById, getTrainerMessages, addTrainerMessage,
} from "@aula-agente/database";
import { publishDraft, getAgentConfigWithStatus, discardDraft, listVersions, getVersionWithDiff, restoreVersion } from "../../services/agent-config.service.js";
import { sendPlaygroundMessage } from "../../services/playground.service.js";
import { suggestConfigFromSystemPrompt } from "../../services/import-suggestion.service.js";
import { proposeConfigChange } from "../../services/trainer.service.js";
import { applyTrainerProposal, rejectTrainerProposal } from "../../services/trainer-decisions.service.js";
import { authMiddleware } from "../../middleware/auth.js";

// `loadOwnedProposal` (in trainer-decisions.service.ts) throws distinct,
// distinguishable messages for three different failure conditions. Map each
// to the HTTP status that actually reflects it: not-found -> 404,
// cross-agent ownership -> 403 (this is the auth boundary), and every
// remaining condition (already decided, unresolved conflicts, no patch) is a
// genuine conflict state -> 409.
function sendTrainerProposalError(reply: FastifyReply, err: unknown) {
  const message = (err as Error).message;
  if (message.includes("does not belong to this agent")) return reply.status(403).send({ error: message });
  if (message.includes("not found")) return reply.status(404).send({ error: message });
  return reply.status(409).send({ error: message });
}

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

  app.post<{ Params: { agentId: string } }>("/agents/:agentId/config/import-suggestion", async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const suggestion = await suggestConfigFromSystemPrompt(db, request.params.agentId);
    return { currentSystemPrompt: agent.system_prompt, suggestion };
  });

  app.get<{ Params: { agentId: string } }>("/agents/:agentId/versions", async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return listVersions(db, request.params.agentId);
  });

  app.get<{ Params: { agentId: string; versionId: string } }>(
    "/agents/:agentId/versions/:versionId",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      return getVersionWithDiff(db, request.params.agentId, request.params.versionId);
    }
  );

  app.post<{ Params: { agentId: string; versionId: string } }>(
    "/agents/:agentId/versions/:versionId/restore",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      return restoreVersion(db, request.params.agentId, request.params.versionId);
    }
  );

  app.post<{ Params: { agentId: string } }>("/agents/:agentId/trainer/sessions", async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const session = await createTrainerSession(db, {
      agentId: request.params.agentId,
      organizationId: agent.organization_id,
      createdBy: request.user.id,
    });
    return reply.status(201).send(session);
  });

  app.get<{ Params: { agentId: string; sessionId: string } }>(
    "/agents/:agentId/trainer/sessions/:sessionId/messages",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const session = await getTrainerSessionById(db, request.params.sessionId);
      if (session.agent_id !== request.params.agentId) {
        return reply.status(403).send({ error: "Session does not belong to this agent" });
      }

      return getTrainerMessages(db, request.params.sessionId);
    }
  );

  app.post<{ Params: { agentId: string; sessionId: string }; Body: { content: string; analyzeConversations?: boolean } }>(
    "/agents/:agentId/trainer/sessions/:sessionId/messages",
    async (request, reply) => {
      const parseResult = sendTrainerMessageSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const session = await getTrainerSessionById(db, request.params.sessionId);
      if (session.agent_id !== request.params.agentId) {
        return reply.status(403).send({ error: "Session does not belong to this agent" });
      }

      const userMessageParams = {
        sessionId: request.params.sessionId,
        organizationId: agent.organization_id,
        role: "user" as const,
        content: parseResult.data.content,
        proposals: [],
      };

      // proposeConfigChange must run BEFORE the user message is persisted —
      // it reads history via getTrainerMessages, and persisting first would
      // make it see the just-saved user message a second time. But that
      // ordering means a failure here (LLM/network error) must not lose the
      // user's message: persist it here on the failure path too, then
      // propagate the error, so the user at least sees their message survived
      // even though the Trainer's reply failed.
      let proposeResult: Awaited<ReturnType<typeof proposeConfigChange>>;
      try {
        proposeResult = await proposeConfigChange(
          db,
          request.params.agentId,
          request.params.sessionId,
          parseResult.data.content,
          parseResult.data.analyzeConversations ?? false
        );
      } catch (err) {
        await addTrainerMessage(db, userMessageParams);
        return reply.status(502).send({ error: (err as Error).message });
      }

      await addTrainerMessage(db, userMessageParams);
      const assistantMessage = await addTrainerMessage(db, {
        sessionId: request.params.sessionId,
        organizationId: agent.organization_id,
        role: "assistant",
        content: proposeResult.content,
        proposals: proposeResult.proposals,
      });
      return reply.status(201).send(assistantMessage);
    }
  );

  app.post<{ Params: { agentId: string; proposalId: string } }>(
    "/agents/:agentId/trainer/proposals/:proposalId/apply",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      try {
        const { proposal } = await applyTrainerProposal(db, request.params.agentId, request.params.proposalId, request.user.id);
        return proposal;
      } catch (err) {
        return sendTrainerProposalError(reply, err);
      }
    }
  );

  app.post<{ Params: { agentId: string; proposalId: string } }>(
    "/agents/:agentId/trainer/proposals/:proposalId/reject",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      try {
        const proposal = await rejectTrainerProposal(db, request.params.agentId, request.params.proposalId);
        return proposal;
      } catch (err) {
        return sendTrainerProposalError(reply, err);
      }
    }
  );
}
