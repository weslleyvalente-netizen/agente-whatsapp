import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdminClient, getOrganizationById } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { getOrComputeSnapshot } from "../../services/health-monitor.js";

export default async function healthRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // Estado de saúde da organização (silêncio de clientes, Redis, Evolution). Qualquer membro pode consultar.
  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/health", async (request, reply) => {
    const { organizationId } = request.params;
    if (!z.string().uuid().safeParse(organizationId).success) return reply.status(400).send({ error: "organizationId inválido" });
    if (!request.user.memberships.some((m) => m.organization_id === organizationId)) {
      return reply.status(403).send({ error: "Access denied" });
    }
    try {
      const org = await getOrganizationById(getAdminClient(), organizationId);
      const s = await getOrComputeSnapshot({ organizationId, settings: org.settings });
      return {
        status: s.status, reasons: s.reasons, lastCustomerMessageAt: s.lastCustomerMessageAt,
        redis: s.redis, evolution: s.evolution,
      };
    } catch (err) {
      request.log.error({ organizationId, errName: (err as Error)?.name }, "health: failed");
      return reply.status(500).send({ error: "Erro ao consultar a saúde" });
    }
  });
}
