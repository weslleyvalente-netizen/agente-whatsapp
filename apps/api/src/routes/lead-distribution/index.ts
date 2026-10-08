import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SALES_REP_AVAILABILITIES } from "@aula-agente/shared";
import {
  acceptAssignment, computeSlaDueAt, getAdminClient, getOrganizationById, getSalesRepByUser, listAssignmentsForContact,
  listOpenExceptions, listSalesReps, listSlaAlerts, manualAssignLead, setRepAvailability,
} from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { isManager, isSellerFilterEnabled, resolveLeadVisibility } from "../../lib/lead-visibility.js";

const uuid = z.string().uuid();

export default async function leadDistributionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  const roleIn = (request: any, organizationId: string): string | null =>
    request.user.memberships.find((m: any) => m.organization_id === organizationId)?.role ?? null;

  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/sales-reps", async (request, reply) => {
    if (!roleIn(request, request.params.organizationId)) return reply.status(403).send({ error: "Access denied" });
    return listSalesReps(getAdminClient(), request.params.organizationId);
  });

  app.patch<{ Params: { organizationId: string; repId: string } }>("/organizations/:organizationId/sales-reps/:repId/availability", async (request, reply) => {
    const { organizationId, repId } = request.params;
    if (!uuid.safeParse(organizationId).success || !uuid.safeParse(repId).success) return reply.status(400).send({ error: "id inválido" });
    const role = roleIn(request, organizationId);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    const body = z.object({ availability: z.enum(SALES_REP_AVAILABILITIES) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues });
    const db = getAdminClient();
    if (!isManager(role)) {
      const own = await getSalesRepByUser(db, organizationId, request.user.id);
      if (!own || own.id !== repId) return reply.status(403).send({ error: "Você só pode alterar a sua própria disponibilidade" });
    }
    try {
      return await setRepAvailability(db, { organizationId, repId, availability: body.data.availability });
    } catch (err) {
      // .single() sem linha (vendedor inexistente nesta organização) → PGRST116.
      if ((err as { code?: string }).code === "PGRST116") return reply.status(404).send({ error: "Vendedor não encontrado" });
      request.log.error({ err, organizationId, repId }, "Failed to update sales rep availability");
      return reply.status(500).send({ error: "Erro ao alterar a disponibilidade" });
    }
  });

  app.post<{ Params: { id: string }; Querystring: { organizationId?: string } }>("/lead-assignments/:id/accept", async (request, reply) => {
    if (!uuid.safeParse(request.params.id).success) return reply.status(400).send({ error: "id inválido" });
    // O parâmetro organizationId é ignorado para autorização: vale a organização real da atribuição.
    const db = getAdminClient();
    const { data: found, error: findError } = await db.from("lead_assignments").select("organization_id").eq("id", request.params.id).maybeSingle();
    if (findError) return reply.status(500).send({ error: "Erro ao buscar a atribuição" });
    if (!found) return reply.status(404).send({ error: "Atribuição não encontrada" });
    const role = roleIn(request, found.organization_id);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    try {
      const accepted = await acceptAssignment(db, { assignmentId: request.params.id, actorUserId: request.user.id, actorIsAdmin: isManager(role) });
      return { accepted };
    } catch (err) {
      const message = (err as { message?: string }).message ?? "Erro ao assumir o lead";
      return reply.status(/Somente o vendedor/.test(message) ? 403 : 500).send({ error: message });
    }
  });

  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/lead-assignments/exceptions", async (request, reply) => {
    const role = roleIn(request, request.params.organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores veem a fila de exceções" });
    return listOpenExceptions(getAdminClient(), request.params.organizationId);
  });

  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/lead-assignments/sla-alerts", async (request, reply) => {
    const role = roleIn(request, request.params.organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores veem os alertas de SLA" });
    return listSlaAlerts(getAdminClient(), request.params.organizationId);
  });

  app.post<{ Params: { organizationId: string } }>("/organizations/:organizationId/lead-assignments/manual", async (request, reply) => {
    const { organizationId } = request.params;
    const role = roleIn(request, organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores reatribuem leads" });
    const body = z.object({ conversationId: uuid, repId: uuid }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues });
    const db = getAdminClient();
    const org = await getOrganizationById(db, organizationId);
    try {
      const assignmentId = await manualAssignLead(db, { organizationId, conversationId: body.data.conversationId, repId: body.data.repId, actorUserId: request.user.id, slaDueAt: computeSlaDueAt(org.settings, new Date()) });
      return { assignmentId };
    } catch (err) {
      return reply.status(400).send({ error: (err as { message?: string }).message ?? "Não foi possível reatribuir" });
    }
  });

  app.get<{ Params: { organizationId: string; contactId: string } }>("/organizations/:organizationId/contacts/:contactId/lead-assignments", async (request, reply) => {
    const { organizationId, contactId } = request.params;
    if (!uuid.safeParse(organizationId).success || !uuid.safeParse(contactId).success) return reply.status(400).send({ error: "id inválido" });
    const role = roleIn(request, organizationId);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    const db = getAdminClient();
    const org = await getOrganizationById(db, organizationId);
    const history = await listAssignmentsForContact(db, organizationId, contactId);
    const visibility = resolveLeadVisibility({ role, userId: request.user.id, leadDistributionEnabled: isSellerFilterEnabled(org.settings) });
    if (visibility.mode === "own") {
      const reps = await listSalesReps(db, organizationId);
      const mine = reps.find(r => r.user_id === visibility.userId);
      const otherRepIds = new Set(reps.filter(r => r.id !== mine?.id).map(r => r.id));
      // Esconde o histórico só quando o lead pertence a outro vendedor e nunca passou pelo próprio.
      const last = history[history.length - 1];
      if (last?.rep_id && otherRepIds.has(last.rep_id) && !history.some(h => h.rep_id === mine?.id)) return [];
    }
    return history;
  });
}
