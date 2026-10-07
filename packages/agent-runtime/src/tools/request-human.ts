import { tool, type Tool } from "ai";
import { z } from "zod";
import {
  getAdminClient,
  updateConversation,
  createHandoffEvent,
  getOrganizationById,
  getOpenTasksByConversation,
  getTaskEvents,
  updateTask,
  addTaskEvent,
  getOpenOpportunitiesByContact,
  createTaskWithDedup,
  distributeLeadForHandoff,
} from "@aula-agente/database";
import { buildHandoffTaskRefresh } from "../handoff-task-refresh.js";
import { safeDistribute } from "../handoff-distribution.js";
import { getSendMessageQueue } from "@aula-agente/queue";
import {
  HANDOFF_MOTIVOS,
  HANDOFF_MOTIVO_LABELS,
  HANDOFF_URGENCIAS,
  isWithinBusinessHours,
  toISODateInTimeZone,
} from "@aula-agente/shared";

interface RequestHumanToolContext {
  contactId: string;
  conversationId: string;
  organizationId: string;
  instanceId: string;
  phone: string;
  businessHoursStartHour: number;
  businessHoursEndHour: number;
}

// Mirrors apps/api/src/services/task.service.ts's handleConversationTakeover
// (same DB-level orchestration: reassign every open task to whoever is now
// handling the conversation, without completing it). Duplicated rather than
// imported because this tool runs from packages/agent-runtime (invoked by
// apps/worker), and apps/api's services aren't a dependency any package can
// reach across the app boundary.
async function reassignOpenTasksToHuman(
  db: ReturnType<typeof getAdminClient>,
  organizationId: string,
  conversationId: string,
  assigneeId: string | null,
  refresh?: {resumo:string;start:number;end:number;contactId:string}
) {
  const openTasks = await getOpenTasksByConversation(db, organizationId, conversationId);
  const opportunities = refresh ? await getOpenOpportunitiesByContact(db, organizationId, refresh.contactId) : [];
  const now=new Date();
  const today=toISODateInTimeZone(now);
  await Promise.all(
    openTasks.map(async (task) => {
      const frozen=opportunities.some(o=>o.frozen_until && o.frozen_until>today && (!task.opportunity_id || o.id===task.opportunity_id));
      const events=refresh && !frozen ? await getTaskEvents(db,task.id):[];
      const changes=refresh && !frozen ? buildHandoffTaskRefresh(task,refresh.resumo,now,refresh.start,refresh.end,events):null;
      const updates = {
        ...changes,
        ...(assigneeId ? { assignee_type: "human" as const, assignee_id: assigneeId } : {}),
        status: task.status === "pending" ? "in_progress" as const : task.status,
      };
      await updateTask(db,task.id,updates,task.updated_at);
      if(changes) await addTaskEvent(db,{task_id:task.id,organization_id:task.organization_id,event_type:"rescheduled",note:`Novo encaminhamento: ${refresh!.resumo}. Contexto anterior: ${task.description}. Vencimento anterior: ${task.due_date}.`,created_by_type:"ai",created_by_id:null});
      await addTaskEvent(db, {
        task_id: task.id,
        organization_id: task.organization_id,
        event_type: "assigned",
        note: "Handoff explícito (requestHuman) — tarefa permanece aberta até conclusão explícita",
        created_by_type: "ai",
        created_by_id: null,
      });
    })
  );
}

// Fase 1 hardening (2026-09-28 incident): requestHuman replaces createTask
// as the handoff path, but if an org hasn't configured EITHER a default
// assignee OR a notification phone, the handoff was landing nowhere —
// recorded in handoff_events, invisible everywhere else. Mirrors
// create-task.ts's own opportunity-linking (exactly one open opportunity
// for the contact, else leave it unlinked — never guess).
async function createFallbackTaskIfUnrouted(
  db: ReturnType<typeof getAdminClient>,
  context: RequestHumanToolContext,
  assigneeId: string | null,
  notifyPhone: string | null,
  motivo: (typeof HANDOFF_MOTIVOS)[number],
  resumo: string,
  urgencia: (typeof HANDOFF_URGENCIAS)[number]
) {
  if (assigneeId || notifyPhone) return;

  try {
    let opportunityId: string | null = null;
    const openOpportunities = await getOpenOpportunitiesByContact(db, context.organizationId, context.contactId);
    if (openOpportunities.length === 1) {
      opportunityId = openOpportunities[0].id;
    }

    await createTaskWithDedup(db, {
      organization_id: context.organizationId,
      contact_id: context.contactId,
      conversation_id: context.conversationId,
      opportunity_id: opportunityId,
      type: "other",
      description: `Handoff sem responsável/telefone de aviso configurado — atender: ${resumo}`,
      reason: `Motivo do handoff: ${HANDOFF_MOTIVO_LABELS[motivo]} (urgência ${urgencia})`,
      priority: urgencia === "alta" ? "urgent" : "normal",
      due_date: toISODateInTimeZone(new Date()),
      created_by_type: "ai",
      created_by_id: null,
    });
  } catch (err) {
    console.error("requestHuman tool: failed to create fallback task (no assignee/phone configured):", err);
  }
}

export function createRequestHumanTool(context: RequestHumanToolContext): Tool {
  return tool({
    description:
      "Aciona um consultor humano para continuar o atendimento — use no lugar de createTask sempre que a situação pedir intervenção humana de verdade: o cliente pediu para falar com alguém, há negociação de valor, uma proposta está pronta para ser fechada, houve reclamação, o pedido está fora do que você pode resolver, ou você não consegue avançar sozinha. NÃO use para perguntas informativas (o que é preciso, quais documentos, como funciona, prazos) — essas você responde direto com a base de conhecimento/FAQ; chame esta ferramenta só quando o cliente já quiser negociar, aderir ou fechar, ou pedir algo que a base não cobre. Isso assume a conversa para um humano de forma explícita e mensurável — não é o mesmo que criar uma tarefa de follow-up. Depois de chamar, avise o cliente com naturalidade que um consultor vai continuar o atendimento (use o texto retornado como guia); não diga que é uma tarefa nem mencione sistemas internos.",
    inputSchema: z.object({
      motivo: z.enum(HANDOFF_MOTIVOS).describe("Motivo do handoff, o que melhor descreve a situação"),
      resumo: z.string().describe("Resumo curto (até 3 linhas) da situação para quem for atender"),
      urgencia: z.enum(HANDOFF_URGENCIAS).default("normal"),
    }),
    execute: async ({ motivo, resumo, urgencia }) => {
      try {
        const db = getAdminClient();
        const org = await getOrganizationById(db, context.organizationId);
        const assigneeId = org.settings.default_handoff_assignee_id ?? null;

        await updateConversation(db, context.conversationId, {
          is_human_takeover: true,
          human_takeover_at: new Date().toISOString(),
          ...(assigneeId ? { assigned_to: assigneeId } : {}),
        });

        const handoffEvent = await createHandoffEvent(db, {
          organization_id: context.organizationId,
          conversation_id: context.conversationId,
          trigger_type: "request_human",
          motivo,
          resumo,
          urgencia,
          criado_por: "ia",
        });

        try {
          await reassignOpenTasksToHuman(db, context.organizationId, context.conversationId, assigneeId,
            org.settings.sales_qualified_handoff_task_enabled===true && ["cliente_pediu","proposta_pronta","negociacao_valor"].includes(motivo) ? {resumo,start:context.businessHoursStartHour,end:context.businessHoursEndHour,contactId:context.contactId}:undefined);
        } catch (err) {
          console.error("requestHuman tool: failed to reassign open tasks:", err);
        }

        // Rodízio (flag lead_distribution_enabled): define o responsável depois do handoff e das tarefas,
        // sobrescrevendo o responsável padrão quando a distribuição está ligada.
        await safeDistribute(distributeLeadForHandoff, db, {
          organizationId: context.organizationId,
          conversationId: context.conversationId,
          handoffEventId: handoffEvent.id,
        });

        const notifyPhone = org.settings.handoff_notification_phone ?? null;
        if (notifyPhone) {
          try {
            await getSendMessageQueue().add("send-message", {
              conversationId: context.conversationId,
              messageId: `handoff-notify-${Date.now()}`,
              instanceId: context.instanceId,
              phone: notifyPhone,
              content: `Handoff (${motivo}, urgência ${urgencia}): ${resumo}`,
              organizationId: context.organizationId,
            });
          } catch (err) {
            console.error("requestHuman tool: failed to send internal notification:", err);
          }
        }

        await createFallbackTaskIfUnrouted(db, context, assigneeId, notifyPhone, motivo, resumo, urgencia);

        const withinHours = isWithinBusinessHours(
          new Date(),
          context.businessHoursStartHour,
          context.businessHoursEndHour
        );

        return withinHours
          ? "Handoff registrado. Avise o cliente com naturalidade que um consultor vai continuar o atendimento a partir de agora."
          : `Handoff registrado, mas estamos fora do horário de atendimento (${context.businessHoursStartHour}h às ${context.businessHoursEndHour}h). Avise o cliente com naturalidade que um consultor vai continuar assim que o atendimento reabrir.`;
      } catch (err) {
        console.error("requestHuman tool failed:", err);
        return "Não foi possível acionar um consultor agora — tente novamente em instantes.";
      }
    },
  });
}
