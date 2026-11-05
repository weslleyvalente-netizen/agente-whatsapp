import type { FastifyInstance } from "fastify";
import {
  messageSuggestionBodySchema, defaultSuggestionMode, latestInstant, originBadge, OPERATION_LABELS,
} from "@aula-agente/shared";
import {
  getAdminClient, getOrganizationById, getOpportunityById, getContactById, getAgentById, getRecentMessages,
  getQualificationByConversationId, listNudgeTasksByConversation,
} from "@aula-agente/database";
import { resolveApiKey, generateSellerMessageSuggestion } from "@aula-agente/agent-runtime";
import { authMiddleware } from "../../middleware/auth.js";
import { canViewLead } from "../../lib/lead-access.js";
import { prepareFollowupAudioContext } from "../../services/followup-audio-context.service.js";

// Limite simples por usuário, em memória (sem persistência): reinicia com o processo, o que basta para conter abuso de custo.
export const SUGGESTION_LIMIT_PER_HOUR = 30;
const WINDOW_MS = 60 * 60 * 1000;
const usage = new Map<string, number[]>();
/** Registra uma tentativa; false quando o usuário já usou o limite na última hora. */
export function takeSuggestionSlot(userId: string, now = Date.now()): boolean {
  const recent = (usage.get(userId) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= SUGGESTION_LIMIT_PER_HOUR) { usage.set(userId, recent); return false; }
  recent.push(now); usage.set(userId, recent);
  return true;
}
export function resetSuggestionLimitForTests() { usage.clear(); }

const MAX_MESSAGE_CHARS = 700;
/** Primeiro nome só quando o contato tem nome de verdade (nada de telefone ou símbolo). */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return /\p{L}{2,}/u.test(first) ? first : null;
}

/**
 * Sugestão de mensagem para o vendedor (primeiro atendimento ou follow-up). Somente leitura do ponto de vista do negócio:
 * nada é enviado ao cliente nem gravado no card; o vendedor edita e envia pelo chat.
 */
export default async function messageSuggestionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/message-suggestion", async (request, reply) => {
    const body = messageSuggestionBodySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.issues });

    const db = getAdminClient();
    const opportunity = await getOpportunityById(db, request.params.opportunityId);
    const membership = request.user.memberships.find(m => m.organization_id === opportunity.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });
    const orgId = opportunity.organization_id;

    const org = await getOrganizationById(db, orgId);
    if (org.settings?.seller_message_suggestion_enabled !== true) return reply.status(404).send({ error: "Sugestão de mensagem não está habilitada" });
    if (!(await canViewLead(db, orgId, membership.role, request.user.id, opportunity.owner_id))) return reply.status(403).send({ error: "Este lead pertence a outro vendedor" });
    if (opportunity.status !== "open") return reply.status(400).send({ error: "A sugestão está disponível só para negócio em andamento" });

    const contact = await getContactById(db, opportunity.contact_id);
    if (contact.organization_id !== orgId) return reply.status(403).send({ error: "Access denied" });
    const { data: conversation, error: conversationError } = await db.from("conversations")
      .select("id,agent_id,organization_id,evolution_instance_id,created_at")
      .eq("organization_id", orgId).eq("contact_id", contact.id).order("last_message_at", { ascending: false }).limit(1).maybeSingle();
    if (conversationError) throw conversationError;
    if (!conversation) return reply.status(409).send({ error: "Ainda não existe conversa com este cliente", reason: "no_conversation" });

    if (!takeSuggestionSlot(request.user.id)) return reply.status(429).send({ error: "Limite de sugestões por hora atingido. Tente novamente mais tarde.", reason: "rate_limited" });

    let prepared;
    try {
      prepared = await prepareFollowupAudioContext(db, conversation as never, await getRecentMessages(db, conversation.id, 20));
    } catch (error) {
      return reply.status(422).send({ error: (error as Error).message, reason: "incomplete_audio_context" });
    }
    const messages = prepared.messages;

    const [qualification, handoff, nudgeTasks] = await Promise.all([
      getQualificationByConversationId(db, conversation.id).catch(() => null),
      db.from("handoff_events").select("resumo,handed_at").eq("organization_id", orgId).eq("conversation_id", conversation.id).eq("trigger_type", "request_human").order("handed_at", { ascending: false }).limit(1).maybeSingle()
        .then(r => (r.error ? null : r.data as { resumo: string | null; handed_at: string | null } | null)),
      listNudgeTasksByConversation(db, orgId, conversation.id).catch(() => null),
    ]);
    const q = qualification && qualification.organization_id === orgId ? qualification : null;

    const lastHuman = [...messages].reverse().find(m => m.role === "human_agent");
    const mode = body.data.mode ?? defaultSuggestionMode({ lastHumanMessageAt: lastHuman?.created_at, since: latestInstant((opportunity as { owner_assigned_at?: string | null }).owner_assigned_at, handoff?.handed_at) });

    let apiKey: string; let agent;
    try {
      agent = await getAgentById(db, conversation.agent_id);
      apiKey = await resolveApiKey(orgId, agent.provider);
    } catch (error) {
      console.error("Message suggestion: agent/key resolution failed:", error);
      return reply.status(503).send({ error: "Não foi possível gerar. Tente de novo.", reason: "generation_failed" });
    }

    const origin = originBadge((contact.metadata as { lead_origin?: { source?: string } } | null)?.lead_origin?.source);
    const result = await generateSellerMessageSuggestion({
      organizationId: orgId, agentId: agent.id, provider: agent.provider, model: agent.model, apiKey, mode,
      previousMessage: body.data.regenerate ? body.data.previousMessage : undefined,
      context: {
        customerFirstName: firstNameOf(contact.name),
        originLabel: origin.tone === "known" ? origin.label : null,
        handoffSummary: handoff?.resumo?.trim() || null,
        qualificationSummary: q?.summary ?? null,
        opportunity: {
          stage: opportunity.stage ?? null,
          operation: OPERATION_LABELS[opportunity.operation] ?? null,
          product: opportunity.product_model ?? q?.product_model ?? q?.product_interest ?? opportunity.product ?? null,
          creditAmount: opportunity.credit_amount ?? null,
          installmentAmount: opportunity.target_installment_amount ?? q?.target_installment_amount ?? null,
          downPaymentAmount: opportunity.down_payment_amount ?? q?.down_payment_amount ?? null,
          bidAmount: opportunity.bid_amount ?? null,
        },
        nudgeCount: nudgeTasks ? nudgeTasks.length : null,
        recentMessages: messages.map(m => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) })),
      },
    });
    if (!result.ok) return reply.status(503).send({ error: "Não foi possível gerar. Tente de novo.", reason: "generation_failed" });
    return reply.status(200).send({ message: result.message, mode });
  });
}
