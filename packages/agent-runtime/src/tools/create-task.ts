import { tool, type Tool } from "ai";
import { z } from "zod";
import { getAdminClient, createTaskWithDedup, getOpenOpportunitiesByContact } from "@aula-agente/database";
import { TASK_TYPES, TASK_PRIORITIES } from "@aula-agente/shared";

interface CreateTaskToolContext {
  contactId: string;
  conversationId: string;
  organizationId: string;
}

export function createCreateTaskTool(context: CreateTaskToolContext): Tool {
  return tool({
    description:
      "Cria uma tarefa de follow-up comercial para lembrar alguém (você mesma ou um humano) de retomar contato com o cliente. Use quando o cliente disser que vai enviar algo depois (CPF, dados, decisão), pedir para ser contatado numa data específica, ou quando uma proposta/simulação for enviada e a conversa ainda não tiver se resolvido. Se já existir uma tarefa aberta parecida para este cliente, ela é atualizada em vez de duplicada — não avise o cliente de que criou uma tarefa, isso é interno. Chame esta ferramenta no máximo uma vez por resposta: se mais de uma pendência precisar de acompanhamento, junte todas em uma única chamada (descrição e motivo cobrindo tudo) em vez de chamar de novo na mesma resposta.",
    inputSchema: z.object({
      type: z.enum(TASK_TYPES).describe("Tipo da tarefa, o que melhor descreve a situação"),
      description: z.string().describe("Descrição curta e específica do que aconteceu e o que fazer"),
      due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve estar no formato YYYY-MM-DD")
        .describe("Data em que a tarefa deve ser feita, formato YYYY-MM-DD, calculada a partir da data atual informada no seu prompt"),
      priority: z.enum(TASK_PRIORITIES).default("normal"),
      reason: z.string().describe("Por que essa tarefa está sendo criada, com base na conversa"),
    }),
    execute: async ({ type, description, due_date, priority, reason }) => {
      // A throw here would reject the whole generateText call and leave the
      // customer with no reply at all, so surface failures to the model as a
      // string it can react to instead.
      try {
        const db = getAdminClient();

        // Scope dedup to the right deal when it's unambiguous: with exactly
        // one open opportunity for this contact, this task belongs to it.
        // With zero or several, don't guess which one — opportunity_id
        // stays null and createTaskWithDedup falls back to its
        // (contact_id, type) dedup, same as before this existed. A lookup
        // failure must never block task creation itself.
        let opportunityId: string | null = null;
        try {
          const openOpportunities = await getOpenOpportunitiesByContact(db, context.organizationId, context.contactId);
          if (openOpportunities.length === 1) {
            opportunityId = openOpportunities[0].id;
          }
        } catch (err) {
          console.error("createTask tool: failed to resolve contact's open opportunity:", err);
        }

        const { task, wasUpdated } = await createTaskWithDedup(db, {
          organization_id: context.organizationId,
          contact_id: context.contactId,
          conversation_id: context.conversationId,
          opportunity_id: opportunityId,
          type,
          description,
          reason,
          priority,
          due_date,
          created_by_type: "ai",
          created_by_id: null,
        });

        return wasUpdated
          ? `Já existia uma tarefa aberta parecida ("${task.title}") — atualizada para ${due_date}.`
          : `Tarefa criada: "${task.title}" para ${due_date}.`;
      } catch (err) {
        console.error("createTask tool failed:", err);
        return "Não foi possível registrar a tarefa agora — tente novamente em instantes.";
      }
    },
  });
}
