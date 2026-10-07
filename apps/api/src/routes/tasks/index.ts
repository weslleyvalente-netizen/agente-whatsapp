import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  createTaskSchema,
  updateTaskSchema,
  rescheduleTaskSchema,
  cancelTaskSchema,
  sendTaskFollowupSchema,
  updateConversationQualificationSchema,
  DEFAULT_TASK_FOLLOWUP_CONFIG,
} from "@aula-agente/shared";
import type { SupabaseClient } from "@aula-agente/database";
import {
  getAdminClient,
  createTaskWithDedup,
  getTaskById,
  getConversationById,
  getQualificationByConversationId,
  upsertConversationQualification,
  decryptCpf,
  getOrganizationById,
  getAgentById,
  getOpportunityById,
  getRecentMessages,
  setFollowupSuggestion,
  incrementFollowupRegenerationCount,
} from "@aula-agente/database";
import { canViewLead } from "../../lib/lead-access.js";
import { resolveApiKey, generateTaskFollowupSuggestion } from "@aula-agente/agent-runtime";
import {
  completeTask,
  cancelTask,
  rescheduleTask,
  updateTaskFields,
  getOrganizationMembersDisplay,
} from "../../services/task.service.js";
import { resolveTaskFollowupEligibility, sendTaskFollowup, getFollowupTouchInfo } from "../../services/task-followup.service.js";
import { prepareFollowupAudioContext } from "../../services/followup-audio-context.service.js";
import { authMiddleware } from "../../middleware/auth.js";

// Confirms a row referenced by id in `table` belongs to `organizationId`,
// so a request in one organization can't attach a task to another
// organization's contact/conversation/opportunity. Used for every
// foreign-key-ish field accepted from the request body — those tables
// aren't otherwise organization-scoped at the DB level, and these routes
// use the RLS-bypassing admin client, so this check is the only guard.
async function belongsToOrganization(
  db: SupabaseClient,
  table: string,
  id: string,
  organizationId: string
): Promise<boolean> {
  const { data } = await db.from(table).select("id").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  return data !== null;
}

export default async function taskRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/members/display",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const members = await getOrganizationMembersDisplay(db, organizationId);
      return members;
    }
  );

  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/details", async (request, reply) => {
    const db = getAdminClient();
    const task = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find((m) => m.organization_id === task.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });
    if (!(await canViewLead(db, task.organization_id, membership.role, request.user.id, task.assignee_id))) return reply.status(403).send({ error: "Este lead pertence a outro vendedor" });

    const conversation = task.conversation_id ? await getConversationById(db, task.conversation_id) : null;
    const qualification = task.conversation_id
      ? await getQualificationByConversationId(db, task.conversation_id)
      : null;

    let decryptedCpf: string | null = null;
    if (qualification?.cpf_encrypted) {
      try {
        decryptedCpf = decryptCpf(qualification.cpf_encrypted);
      } catch (err) {
        console.error(`Failed to decrypt CPF for qualification ${qualification.id}:`, err);
      }
    }

    return {
      task,
      customer: conversation
        ? { id: conversation.wa_contacts.id, name: conversation.wa_contacts.name, phone: conversation.wa_contacts.phone }
        : null,
      conversation: conversation ? { id: conversation.id, lastMessageAt: conversation.last_message_at } : null,
      qualification: qualification
        ? {
            attendance_type: qualification.attendance_type,
            product_interest: qualification.product_interest,
            product_model: qualification.product_model,
            usage_purpose: qualification.usage_purpose,
            city: qualification.city,
            urgency: qualification.urgency,
            sale_amount: qualification.sale_amount,
            credit_amount: qualification.credit_amount,
            down_payment_amount: qualification.down_payment_amount,
            bid_amount: qualification.bid_amount,
            target_installment_amount: qualification.target_installment_amount,
            term_months: qualification.term_months,
            cpf: decryptedCpf,
            birth_date: qualification.birth_date,
            has_driver_license: qualification.has_driver_license,
            driver_license_category: qualification.driver_license_category,
            summary: qualification.summary,
            next_action: qualification.next_action,
            commercial_notes: qualification.commercial_notes,
          }
        : null,
    };
  });

  app.post<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/tasks",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const parseResult = createTaskSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();

      if (!(await belongsToOrganization(db, "wa_contacts", parseResult.data.contact_id, organizationId))) {
        return reply.status(403).send({ error: "Contact does not belong to this organization" });
      }

      if (
        parseResult.data.conversation_id &&
        !(await belongsToOrganization(db, "conversations", parseResult.data.conversation_id, organizationId))
      ) {
        return reply.status(403).send({ error: "Conversation does not belong to this organization" });
      }

      if (
        parseResult.data.opportunity_id &&
        !(await belongsToOrganization(db, "opportunities", parseResult.data.opportunity_id, organizationId))
      ) {
        return reply.status(403).send({ error: "Opportunity does not belong to this organization" });
      }

      const { task, wasUpdated } = await createTaskWithDedup(db, {
        organization_id: organizationId,
        contact_id: parseResult.data.contact_id,
        conversation_id: parseResult.data.conversation_id ?? null,
        opportunity_id: parseResult.data.opportunity_id ?? null,
        type: parseResult.data.type,
        description: parseResult.data.description,
        reason: parseResult.data.reason ?? null,
        priority: parseResult.data.priority,
        due_date: parseResult.data.due_date,
        due_time: parseResult.data.due_time ?? null,
        created_by_type: "human",
        created_by_id: request.user.id,
        assignee_type: parseResult.data.assignee_type ?? null,
        assignee_id: parseResult.data.assignee_id ?? null,
      });

      return reply.status(201).send({ task, wasUpdated });
    }
  );

  app.patch<{ Params: { taskId: string } }>("/tasks/:taskId", async (request, reply) => {
    const parseResult = updateTaskSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    if (
      parseResult.data.opportunity_id &&
      !(await belongsToOrganization(db, "opportunities", parseResult.data.opportunity_id, existing.organization_id))
    ) {
      return reply.status(403).send({ error: "Opportunity does not belong to this organization" });
    }

    const task = await updateTaskFields(db, request.params.taskId, parseResult.data, request.user.id);
    return task;
  });

  app.post<{ Params: { taskId: string } }>("/tasks/:taskId/complete", async (request, reply) => {
    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return completeTask(db, request.params.taskId, { type: "human", id: request.user.id });
  });

  app.post<{ Params: { taskId: string } }>("/tasks/:taskId/cancel", async (request, reply) => {
    const parseResult = cancelTaskSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const task = await cancelTask(
      db,
      request.params.taskId,
      { type: "human", id: request.user.id },
      parseResult.data.note ?? null
    );
    return task;
  });

  app.post<{ Params: { taskId: string } }>("/tasks/:taskId/reschedule", async (request, reply) => {
    const parseResult = rescheduleTaskSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const task = await rescheduleTask(
      db,
      request.params.taskId,
      { type: "human", id: request.user.id },
      parseResult.data.due_date,
      parseResult.data.due_time ?? null
    );
    return task;
  });

  // Follow-up direto da tarefa (D1-D7 em docs/plano-followup-tarefa.md).
  // Generates (or regenerates, via "Gerar outra") the AI-suggested message
  // shown editable in the task panel. The very first generation for a task
  // doesn't count against task_followup_max_regenerations — only an
  // explicit regeneration (a stored suggestion already existed) does.
  app.post<{ Params: { taskId: string } }>("/tasks/:taskId/followup-suggestion", async (request, reply) => {
    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const org = await getOrganizationById(db, existing.organization_id);
    if (!org.settings?.task_followup_enabled) {
      return reply.status(404).send({ error: "Follow-up direto da tarefa não está habilitado" });
    }

    const eligibility = await resolveTaskFollowupEligibility(db, existing);
    if (!eligibility.eligible) {
      return reply.status(400).send({ error: "Tarefa não elegível para follow-up", reason: eligibility.reason });
    }

    const maxRegenerations = org.settings.task_followup_max_regenerations ?? DEFAULT_TASK_FOLLOWUP_CONFIG.max_regenerations;
    const body = z.object({ regenerate: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.issues });
    const touchInfo = await getFollowupTouchInfo(db, eligibility.conversation);
    const { conversation } = eligibility;
    let prepared;
    try {
      prepared = await prepareFollowupAudioContext(db, conversation, await getRecentMessages(db, conversation.id, 20));
    } catch (error) {
      return reply.status(422).send({ error: (error as Error).message, reason: "incomplete_audio_context" });
    }
    const audioContextUpdated = prepared.changed || prepared.messages.some(m => m.metadata?.audio_transcribed_at && (!existing.followup_suggestion_generated_at || new Date(m.metadata.audio_transcribed_at).getTime() > new Date(existing.followup_suggestion_generated_at).getTime()));
    if (existing.followup_suggested_message && !body.data.regenerate && !audioContextUpdated) return reply.send({
      message: existing.followup_suggested_message,
      regenerationsRemaining: Math.max(maxRegenerations - existing.followup_regeneration_count, 0), touch: touchInfo,
    });
    const isRegeneration = !!existing.followup_suggested_message;
    if (isRegeneration && existing.followup_regeneration_count >= maxRegenerations) {
      if (audioContextUpdated) return reply.status(422).send({ error: "O áudio foi recuperado, mas o limite de regenerações foi atingido. A sugestão antiga foi bloqueada; escreva a mensagem manualmente.", reason: "audio_context_updated", regenerationsRemaining: 0 });
      return reply.status(429).send({ error: "Limite de regenerações atingido", regenerationsRemaining: 0 });
    }

    const agent = await getAgentById(db, conversation.agent_id);
    const apiKey = await resolveApiKey(existing.organization_id, agent.provider);

    const recentMessages = prepared.messages;
    const qualification = await getQualificationByConversationId(db, conversation.id).catch(() => null);
    const opportunity = existing.opportunity_id ? await getOpportunityById(db, existing.opportunity_id) : null;

    const suggestion = await generateTaskFollowupSuggestion({
      organizationId: existing.organization_id,
      agentId: agent.id,
      provider: agent.provider,
      model: agent.model,
      apiKey,
      task: { type: existing.type, description: existing.description },
      previousMessage: isRegeneration ? existing.followup_suggested_message ?? undefined : undefined,
      reuseTaskDescriptionIfLiberaCred: existing.type === "libera_cred_resumption" && !isRegeneration,
      context: {
        recentMessages: recentMessages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
        qualificationSummary: qualification?.summary ?? null,
        opportunity: opportunity
          ? {
              stage: opportunity.stage ?? null,
              creditAmount: opportunity.credit_amount ?? null,
              saleAmount: opportunity.sale_amount ?? null,
              bidAmount: opportunity.bid_amount ?? null,
            }
          : null,
      },
    });

    if (suggestion.generated === false) return reply.status(503).send({
      error: "Não foi possível gerar a sugestão. Tente novamente.", reason: "generation_failed",
      regenerationsRemaining: Math.max(maxRegenerations - existing.followup_regeneration_count, 0),
    });
    await setFollowupSuggestion(db, existing.id, suggestion.message);

    const newCount = isRegeneration ? existing.followup_regeneration_count + 1 : existing.followup_regeneration_count;
    if (isRegeneration) {
      await incrementFollowupRegenerationCount(db, existing.id, newCount);
    }

    return reply.status(200).send({
      message: suggestion.message,
      regenerationsRemaining: Math.max(maxRegenerations - newCount, 0),
      touch: touchInfo,
    });
  });

  app.post<{ Params: { taskId: string } }>("/tasks/:taskId/send-followup", async (request, reply) => {
    const parseResult = sendTaskFollowupSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const org = await getOrganizationById(db, existing.organization_id);
    if (!org.settings?.task_followup_enabled) {
      return reply.status(404).send({ error: "Follow-up direto da tarefa não está habilitado" });
    }

    const result = await sendTaskFollowup({
      taskId: existing.id,
      organizationId: existing.organization_id,
      message: parseResult.data.message,
      actorUserId: request.user.id,
      regenerationsBeforeSend: existing.followup_regeneration_count,
      force: parseResult.data.force,
    });

    if (result.ok) {
      return reply.status(200).send({ task: result.task });
    }

    switch (result.reason) {
      case "not_eligible":
        return reply.status(400).send({ error: "Tarefa não elegível para follow-up", reason: result.detail });
      case "min_interval":
        return reply
          .status(429)
          .send({ error: "Aguarde antes de enviar outro follow-up", reason: result.reason, retryAfterSeconds: result.retryAfterSeconds });
      case "daily_limit":
        return reply
          .status(429)
          .send({ error: "Limite diário de follow-ups atingido para este número", reason: result.reason });
      case "recent_touch":
        return reply.status(409).send({
          error: "Já houve contato de saída recentemente",
          reason: result.reason,
          hoursSinceTouch: result.hoursSinceTouch,
          canForce: true,
        });
      case "touch_limit_reached":
        return reply.status(409).send({
          error: "Limite de toques sem resposta atingido",
          reason: result.reason,
          touchCount: result.touchCount,
          suggestMarkLost: true,
          canForce: true,
        });
      case "unconfirmed":
        return reply.status(409).send({
          error: "Envio não confirmado — verifique antes de tentar de novo",
          reason: result.reason,
          pendingMessageId: result.pendingMessageId,
          canForce: true,
        });
      case "send_failed":
        return reply.status(502).send({ error: "Falha ao enviar o follow-up", reason: result.reason, detail: result.detail });
      default:
        return reply.status(500).send({ error: "Erro inesperado ao enviar o follow-up" });
    }
  });

  app.patch<{ Params: { conversationId: string } }>(
    "/conversations/:conversationId/qualification",
    async (request, reply) => {
      const parseResult = updateConversationQualificationSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const conversation = await getConversationById(db, request.params.conversationId);
      const membership = request.user.memberships.find(
        (m) => m.organization_id === conversation.organization_id
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const { cpf, birth_date, has_driver_license, driver_license_category, ...commercialFields } =
        parseResult.data;

      await upsertConversationQualification(db, {
        organizationId: conversation.organization_id,
        conversationId: request.params.conversationId,
        contactId: conversation.contact_id,
        changedByType: "human",
        changedById: request.user.id,
        fields: commercialFields,
        identity: cpf !== undefined || birth_date !== undefined || has_driver_license !== undefined || driver_license_category !== undefined
          ? { cpf, birth_date, has_driver_license, driver_license_category }
          : undefined,
      });

      return { ok: true };
    }
  );
}
