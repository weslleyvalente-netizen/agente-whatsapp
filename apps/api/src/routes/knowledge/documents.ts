import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { getAdminClient } from "@aula-agente/database";
import { getDocumentsByAgent, getDocumentById, deleteDocument } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { uploadDocument } from "../../services/knowledge.service.js";
import type { DocumentFileType } from "@aula-agente/shared";

export default async function knowledgeDocumentRoutes(app: FastifyInstance) {
  app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  app.addHook("preHandler", authMiddleware);

  // List documents for an agent
  app.get<{ Params: { organizationId: string; agentId: string } }>(
    "/organizations/:organizationId/agents/:agentId/documents",
    async (request, reply) => {
      const { organizationId, agentId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const documents = await getDocumentsByAgent(db, agentId);
      return documents;
    }
  );

  // Upload document
  app.post<{ Params: { organizationId: string; agentId: string } }>(
    "/organizations/:organizationId/agents/:agentId/documents",
    async (request, reply) => {
      const { organizationId, agentId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId && m.role !== "agent"
      );
      if (!membership) return reply.status(403).send({ error: "Admin access required" });

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: "No file uploaded" });
      }

      const fileBuffer = await data.toBuffer();
      const fileName = data.filename;
      const ext = fileName.split(".").pop()?.toLowerCase() as DocumentFileType;
      const title = (data.fields.title as any)?.value || fileName;

      const document = await uploadDocument({
        organizationId,
        agentId,
        title,
        fileName,
        fileBuffer,
        fileType: ext,
      });

      return reply.status(201).send(document);
    }
  );

  // Delete document
  app.delete<{ Params: { documentId: string } }>(
    "/documents/:documentId",
    async (request, reply) => {
      const db = getAdminClient();
      const doc = await getDocumentById(db, request.params.documentId);

      const membership = request.user.memberships.find(
        (m) => m.organization_id === doc.organization_id && m.role !== "agent"
      );
      if (!membership) return reply.status(403).send({ error: "Admin access required" });

      await deleteDocument(db, doc.id);
      return reply.status(204).send();
    }
  );
}
