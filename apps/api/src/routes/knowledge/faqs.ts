import type { FastifyInstance } from "fastify";
import { createFaqSchema, updateFaqSchema } from "@aula-agente/shared";
import { getAdminClient } from "@aula-agente/database";
import { getFaqsByAgent, getFaqById, createFaq, updateFaq, deleteFaq } from "@aula-agente/database";
import { isManager } from "../../lib/lead-visibility.js";
import { authMiddleware } from "../../middleware/auth.js";

export default async function knowledgeFaqRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // List FAQs for an agent
  app.get<{ Params: { organizationId: string; agentId: string } }>(
    "/organizations/:organizationId/agents/:agentId/faqs",
    async (request, reply) => {
      const { organizationId, agentId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const faqs = await getFaqsByAgent(db, agentId);
      return faqs;
    }
  );

  // Create FAQ
  app.post<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/faqs",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId && m.role !== "agent"
      );
      if (!membership) return reply.status(403).send({ error: "Admin access required" });

      const parseResult = createFaqSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const faq = await createFaq(db, {
        ...parseResult.data,
        organization_id: organizationId,
        is_active: true,
      });

      return reply.status(201).send(faq);
    }
  );

  // Update FAQ
  app.patch<{ Params: { faqId: string } }>(
    "/faqs/:faqId",
    async (request, reply) => {
      const parseResult = updateFaqSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const existing = await getFaqById(db, request.params.faqId);
      if (!existing) return reply.status(404).send({ error: "FAQ not found" });
      const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id && isManager(m.role));
      if (!membership) return reply.status(403).send({ error: "Admin access required" });
      const faq = await updateFaq(db, existing.id, parseResult.data);
      return faq;
    }
  );

  // Delete FAQ
  app.delete<{ Params: { faqId: string } }>(
    "/faqs/:faqId",
    async (request, reply) => {
      const db = getAdminClient();
      const existing = await getFaqById(db, request.params.faqId);
      if (!existing) return reply.status(404).send({ error: "FAQ not found" });
      const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id && isManager(m.role));
      if (!membership) return reply.status(403).send({ error: "Admin access required" });
      await deleteFaq(db, existing.id);
      return reply.status(204).send();
    }
  );
}
