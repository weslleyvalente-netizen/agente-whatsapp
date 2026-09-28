import { tool, type Tool } from "ai";
import { z } from "zod";
import {
  getAdminClient,
  updateConversation,
  createHandoffEvent,
  getOrganizationById,
  getOpenTasksByConversation,
  updateTask,
  addTaskEvent,
} from "@aula-agente/database";
import { getSendMessageQueue } from "@aula-agente/queue";
import { HANDOFF_MOTIVOS, HANDOFF_URGENCIAS, isWithinBusinessHours } from "@aula-agente/shared";

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
  assigneeId: string | null
) {
  const openTasks = await getOpenTasksByConversation(db, organizationId, conversationId);
  await Promise.all(
    openTasks.map(async (task) => {
      await updateTask(db, task.id, {
        ...(assigneeId ? { assignee_type: "human" as const, assignee_id: assigneeId } : {}),
        status: task.status === "pending" ? "in_progress" : task.status,
      });
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

export function createRequestHumanTool(context: RequestHumanToolContext): Tool {
  return tool({
    description:
      "Aciona um consultor humano para continuar o atendimento — use no lugar de createTask sempre que a situação pedir intervenção humana de verdade: o cliente pediu para falar com alguém, há negociação de valor, uma proposta está pronta para ser fechada, é preciso coletar/confirmar documentos, houve reclamação, o pedido está fora do que você pode resolver, ou você não consegue avançar sozinha. Isso assume a conversa para um humano de forma explícita e mensurável — não é o mesmo que criar uma tarefa de follow-up. Depois de chamar, avise o cliente com naturalidade que um consultor vai continuar o atendimento (use o texto retornado como guia); não diga que é uma tarefa nem mencione sistemas internos.",
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

        await createHandoffEvent(db, {
          organization_id: context.organizationId,
          conversation_id: context.conversationId,
          trigger_type: "request_human",
          motivo,
          resumo,
          urgencia,
          criado_por: "ia",
        });

        try {
          await reassignOpenTasksToHuman(db, context.organizationId, context.conversationId, assigneeId);
        } catch (err) {
          console.error("requestHuman tool: failed to reassign open tasks:", err);
        }

        const notifyPhone = org.settings.handoff_notification_phone;
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
