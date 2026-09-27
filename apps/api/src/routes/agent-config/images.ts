import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { getAdminClient, getAgentById } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { InvalidImageError, MAX_AGENT_IMAGE_BYTES, uploadAgentImage } from "../../services/agent-media.service.js";

// Only stores the file. The panel then adds/updates the item in the draft's
// knowledge.imagens through the normal draft PATCH, so the image goes live
// only when the draft is published.
export default async function agentImageRoutes(app: FastifyInstance) {
  app.register(multipart, { limits: { fileSize: MAX_AGENT_IMAGE_BYTES, files: 1 } });
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { organizationId: string; agentId: string } }>(
    "/organizations/:organizationId/agents/:agentId/config/images",
    async (request, reply) => {
      const { organizationId, agentId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId && m.role !== "agent"
      );
      if (!membership) return reply.status(403).send({ error: "Admin access required" });

      const db = getAdminClient();
      const agent = await getAgentById(db, agentId).catch(() => null);
      if (!agent || agent.organization_id !== organizationId) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const data = await request.file();
      if (!data) return reply.status(400).send({ error: "Nenhum arquivo enviado." });

      let file: Buffer;
      try {
        file = await data.toBuffer();
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.status(413).send({ error: "Imagem acima de 5 MB." });
        }
        throw err;
      }

      try {
        const stored = await uploadAgentImage(db, { organizationId, agentId, file });
        return reply.status(201).send(stored);
      } catch (err) {
        if (err instanceof InvalidImageError) return reply.status(400).send({ error: err.message });
        throw err;
      }
    }
  );
}
