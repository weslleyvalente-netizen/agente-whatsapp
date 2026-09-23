import type { FastifyInstance } from "fastify";
import {
  createOpportunitySchema,
  updateOpportunitySchema,
  changeOpportunityStageSchema,
  changeOpportunityOperationSchema,
  markOpportunityWonSchema,
  markOpportunityLostSchema,
} from "@aula-agente/shared";
import {
  getAdminClient,
  createOpportunity,
  getOpportunityById,
  getOpportunitiesByOrganization,
  addOpportunityEvent,
} from "@aula-agente/database";
import {
  changeStage,
  changeOperation,
  markWon,
  markLost,
  updateOpportunityFields,
} from "../../services/opportunity.service.js";
import { authMiddleware } from "../../middleware/auth.js";

export default async function opportunityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { organizationId: string }; Querystring: { operation?: string; status?: string } }>(
    "/organizations/:organizationId/opportunities",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      return getOpportunitiesByOrganization(db, organizationId, request.query);
    }
  );

  app.post<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/opportunities",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const parseResult = createOpportunitySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();

      const { data: contact } = await db
        .from("wa_contacts")
        .select("id")
        .eq("id", parseResult.data.contact_id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!contact) {
        return reply.status(403).send({ error: "Contact does not belong to this organization" });
      }

      const opportunity = await createOpportunity(db, {
        organization_id: organizationId,
        contact_id: parseResult.data.contact_id,
        operation: parseResult.data.operation,
        stage: parseResult.data.stage,
        status: "open",
        product: parseResult.data.product ?? null,
        product_model: parseResult.data.product_model ?? null,
        initial_operation: parseResult.data.operation,
        sale_amount: parseResult.data.sale_amount ?? null,
        credit_amount: parseResult.data.credit_amount ?? null,
        down_payment_amount: parseResult.data.down_payment_amount ?? null,
        bid_amount: parseResult.data.bid_amount ?? null,
        target_installment_amount: parseResult.data.target_installment_amount ?? null,
        term_months: parseResult.data.term_months ?? null,
        usage_purpose: parseResult.data.usage_purpose ?? null,
        urgency: parseResult.data.urgency ?? null,
        main_objection: parseResult.data.main_objection ?? null,
        commercial_notes: parseResult.data.commercial_notes ?? null,
        owner_id: parseResult.data.owner_id,
        next_action: parseResult.data.next_action,
        next_action_due_date: parseResult.data.next_action_due_date,
        waiting_on: null,
        waiting_on_until: null,
        last_interaction_at: parseResult.data.last_interaction_at ?? null,
        last_progress_at: new Date().toISOString(),
        lost_reason: null,
        resume_date: null,
        ...(parseResult.data.created_at ? { created_at: parseResult.data.created_at } : {}),
      });

      await addOpportunityEvent(db, {
        organization_id: organizationId,
        opportunity_id: opportunity.id,
        event_type: "created",
        previous_value: null,
        new_value: { operation: opportunity.operation, stage: opportunity.stage },
        evidence: parseResult.data.evidence ?? "Oportunidade criada manualmente",
        changed_by_type: "human",
        changed_by_id: request.user.id,
      });

      return reply.status(201).send(opportunity);
    }
  );

  app.patch<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId", async (request, reply) => {
    const parseResult = updateOpportunitySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getOpportunityById(db, request.params.opportunityId);
    const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return updateOpportunityFields(db, request.params.opportunityId, parseResult.data);
  });

  app.post<{ Params: { opportunityId: string } }>(
    "/opportunities/:opportunityId/stage",
    async (request, reply) => {
      const parseResult = changeOpportunityStageSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const existing = await getOpportunityById(db, request.params.opportunityId);
      const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      try {
        const opportunity = await changeStage(
          db,
          request.params.opportunityId,
          parseResult.data.stage,
          parseResult.data.evidence,
          { type: "human", id: request.user.id }
        );
        return opportunity;
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { opportunityId: string } }>(
    "/opportunities/:opportunityId/operation",
    async (request, reply) => {
      const parseResult = changeOpportunityOperationSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const existing = await getOpportunityById(db, request.params.opportunityId);
      const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      return changeOperation(db, request.params.opportunityId, parseResult.data.operation, parseResult.data.evidence, {
        type: "human",
        id: request.user.id,
      });
    }
  );

  app.post<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/won", async (request, reply) => {
    const parseResult = markOpportunityWonSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getOpportunityById(db, request.params.opportunityId);
    const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return markWon(db, request.params.opportunityId, parseResult.data.evidence, { type: "human", id: request.user.id });
  });

  app.post<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/lost", async (request, reply) => {
    const parseResult = markOpportunityLostSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getOpportunityById(db, request.params.opportunityId);
    const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return markLost(
      db,
      request.params.opportunityId,
      parseResult.data.evidence,
      parseResult.data.lost_reason,
      parseResult.data.resume_date ?? null,
      { type: "human", id: request.user.id }
    );
  });
}
