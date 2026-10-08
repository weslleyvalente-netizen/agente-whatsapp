import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  isValidFreezeDate, toISODateInTimeZone,
  createOpportunitySchema,
  updateOpportunitySchema,
  changeOpportunityStageSchema,
  changeOpportunityOperationSchema,
  markOpportunityWonSchema,
  markOpportunityLostSchema,
} from "@aula-agente/shared";
import {
  freezeOpportunity, getUnidentifiedSalesContacts, listSalesReps,
  getAdminClient,
  getOrganizationById,
  createOpportunity,
  getOpportunityById,
  getOpportunitiesByOrganization,
  addOpportunityEvent,
  getContactById, getQualificationByConversationId, getOpportunityEvents, getOpenTasksByContact, decryptCpf,
} from "@aula-agente/database";
import {
  changeStage,
  changeOperation,
  markWon,
  markLost,
  updateOpportunityFields,
} from "../../services/opportunity.service.js";
import { authMiddleware } from "../../middleware/auth.js";
import { isLeadVisible, isSellerFilterEnabled, resolveLeadVisibility } from "../../lib/lead-visibility.js";
import { canViewLead } from "../../lib/lead-access.js";

import { enrichSalesWorkspace, getSalesTasksWithoutOpenBusiness } from "../../services/sales-workspace.service.js";

export default async function opportunityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { organizationId: string }; Querystring: { operation?: string; status?: string } }>(
    "/organizations/:organizationId/opportunities",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const [rows, organization] = await Promise.all([getOpportunitiesByOrganization(db, organizationId, request.query), getOrganizationById(db, organizationId)]);
      const leadDistributionEnabled = isSellerFilterEnabled(organization.settings);
      const viewer = resolveLeadVisibility({ role: membership.role, userId: request.user.id, leadDistributionEnabled });
      return enrichSalesWorkspace(db, organizationId, rows, organization.settings.sales_workspace_enabled === true || organization.settings.sales_action_queue_enabled === true,
        leadDistributionEnabled ? { enabled: true, viewer } : undefined);
    }
  );

  app.get<{Params:{organizationId:string}}>("/organizations/:organizationId/opportunities/pending-tasks",async(request,reply)=>{
    const orgId=request.params.organizationId;
    const member=request.user.memberships.find(m=>m.organization_id===orgId);
    if(!member)return reply.status(403).send({error:"Access denied"});
    const db=getAdminClient();const org=await getOrganizationById(db,orgId);
    if(org.settings.sales_action_queue_enabled!==true)return [];
    const tasks=await getSalesTasksWithoutOpenBusiness(db,orgId);
    const viewer=resolveLeadVisibility({role:member.role,userId:request.user.id,leadDistributionEnabled:isSellerFilterEnabled(org.settings)});
    if(viewer.mode==="all")return tasks;
    const repUsers=new Set((await listSalesReps(db,orgId)).map(r=>r.user_id));
    return tasks.filter((t:any)=>isLeadVisible(viewer,t.assignee_id,repUsers));
  });

  app.get<{Params:{organizationId:string}}>("/organizations/:organizationId/opportunities/unidentified",async(request,reply)=>{
    const orgId=request.params.organizationId;
    if(!request.user.memberships.some(m=>m.organization_id===orgId))return reply.status(403).send({error:"Access denied"});
    const db=getAdminClient();const org=await getOrganizationById(db,orgId);
    if(org.settings.sales_auto_pipeline_enabled!==true)return [];
    return getUnidentifiedSalesContacts(db,orgId);
  });

  app.post<{Params:{opportunityId:string}}>("/opportunities/:opportunityId/freeze", async(request,reply)=>{
    const parsed=z.object({date:z.string().nullable(),reason:z.string().trim().min(1).max(2000)}).safeParse(request.body);
    if(!parsed.success) return reply.status(400).send({error:parsed.error.issues});
    if(parsed.data.date!==null && !isValidFreezeDate(parsed.data.date,toISODateInTimeZone(new Date()))) return reply.status(400).send({error:"Informe uma data futura válida"});
    const db=getAdminClient(); const o=await getOpportunityById(db,request.params.opportunityId);
    if(!request.user.memberships.some(m=>m.organization_id===o.organization_id)) return reply.status(403).send({error:"Access denied"});
    return freezeOpportunity(db,{organizationId:o.organization_id,opportunityId:o.id,actorId:request.user.id,date:parsed.data.date,reason:parsed.data.reason});
  });

  app.patch<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/origin", async (request, reply) => {
    const db = getAdminClient();
    const opportunity = await getOpportunityById(db, request.params.opportunityId);
    if (!request.user.memberships.some(m => m.organization_id === opportunity.organization_id)) return reply.status(403).send({ error: "Access denied" });
    const parsed = z.object({ source: z.enum(["site_wix", "facebook_ads", "instagram_ads", "meta_ads", "instagram_organic"]), evidence: z.string().trim().max(1000).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues });
    const contact = await getContactById(db, opportunity.contact_id);
    if (contact.organization_id !== opportunity.organization_id) return reply.status(403).send({ error: "Access denied" });
    const origin = { ...parsed.data, evidence: parsed.data.evidence || "Correção manual pela atendente", method: "manual", identified_at: new Date().toISOString(), changed_by_id: request.user.id };
    let query = db.from("wa_contacts").update({ metadata: { ...contact.metadata, lead_origin: origin } }).eq("organization_id", opportunity.organization_id).eq("id", contact.id);
    query = contact.metadata == null ? query.is("metadata", null) : query.eq("metadata", JSON.stringify(contact.metadata));
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw error;
    if (!data) return reply.status(409).send({ error: "Os dados mudaram. Atualize o card e tente novamente." });
    return { origin };
  });

  app.get<{ Params: { opportunityId: string }; Querystring: { revealCpf?: string } }>("/opportunities/:opportunityId/details", async (request, reply) => {
    const db = getAdminClient();
    const opportunity = await getOpportunityById(db, request.params.opportunityId);
    const detailMembership = request.user.memberships.find(m => m.organization_id === opportunity.organization_id);
    if (!detailMembership) return reply.status(403).send({ error: "Access denied" });
    if (!(await canViewLead(db, opportunity.organization_id, detailMembership.role, request.user.id, opportunity.owner_id))) return reply.status(403).send({ error: "Este lead pertence a outro vendedor" });
    const customer = await getContactById(db, opportunity.contact_id);
    if (customer.organization_id !== opportunity.organization_id) return reply.status(403).send({ error: "Access denied" });
    const { data: conversation, error } = await db.from("conversations").select("id,last_message_at,status").eq("organization_id", opportunity.organization_id).eq("contact_id", opportunity.contact_id).order("last_message_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    const raw = conversation ? await getQualificationByConversationId(db, conversation.id) : null;
    const qualification = raw && raw.organization_id === opportunity.organization_id ? (() => {
      const { cpf_encrypted, cpf_hash, ...safe } = raw;
      return { ...safe, has_cpf: !!cpf_encrypted, cpf: request.query.revealCpf === "true" && cpf_encrypted ? decryptCpf(cpf_encrypted) : null };
    })() : null;
    const [events, tasks] = await Promise.all([getOpportunityEvents(db, opportunity.id), getOpenTasksByContact(db, opportunity.organization_id, opportunity.contact_id)]);
    return { opportunity, customer: { id: customer.id, name: customer.name, phone: customer.phone }, conversation, qualification, events, tasks: tasks.filter(t => t.opportunity_id === opportunity.id || !t.opportunity_id), origin: customer.metadata?.lead_origin ?? null };
  });

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
