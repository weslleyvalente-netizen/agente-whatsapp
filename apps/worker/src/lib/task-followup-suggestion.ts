import { generateObject } from "ai";
import { z } from "zod";
import { createModel, extractTokenUsage } from "@aula-agente/agent-runtime";
import { recordAiUsageEvent, getAdminClient } from "@aula-agente/database";
import type { LLMProvider, TaskType } from "@aula-agente/shared";

export function buildTaskFollowupSystemPrompt(): string {
  return (
    "Você ajuda uma atendente de uma loja a retomar contato com um cliente numa tarefa em " +
    "aberto. Escreva uma mensagem curta e natural, em português, para a ATENDENTE enviar " +
    "manualmente pelo WhatsApp — você não está enviando nada ao cliente agora, só sugerindo " +
    "o texto que ela pode editar antes de mandar. Baseie-se apenas no histórico recente da " +
    "conversa, na qualificação e na oportunidade fornecidos. Nunca invente valor, prazo, " +
    "modelo, condição ou qualquer dado sobre o cliente que não esteja presente no contexto " +
    "dado — se faltar informação, escreva algo genérico que ainda faça sentido em vez de " +
    "adivinhar. Não use placeholders como [nome] ou [modelo]."
  );
}

const suggestionSchema = z.object({ message: z.string() });

export interface TaskFollowupOpportunityContext {
  stage: string | null;
  creditAmount: number | null;
  saleAmount: number | null;
  bidAmount: number | null;
}

export interface GenerateTaskFollowupSuggestionParams {
  organizationId: string;
  agentId: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  task: { type: TaskType; description: string };
  // Only true on the very first suggestion for a libera_cred_resumption
  // task that has no stored suggestion yet — Fase 2 already generated a
  // grounded message for it (see libera-cred-resumption-message.ts), so
  // this reuses task.description instead of a second AI call. "Gerar
  // outra" always passes false, even for this task type.
  reuseTaskDescriptionIfLiberaCred: boolean;
  context: {
    recentMessages: Array<{ role: string; content: string }>;
    qualificationSummary: string | null;
    opportunity: TaskFollowupOpportunityContext | null;
  };
}

export interface TaskFollowupSuggestionResult {
  message: string;
}

const FALLBACK_MESSAGE = "Oi! Passando para saber se ficou alguma dúvida sobre o que conversamos — posso ajudar?";

function buildUserPrompt(params: GenerateTaskFollowupSuggestionParams): string {
  const { task, context } = params;
  const lines: string[] = [
    `Tipo de tarefa: ${task.type}`,
    `Descrição da tarefa: ${task.description}`,
  ];
  if (context.qualificationSummary) {
    lines.push(`Qualificação registrada: ${context.qualificationSummary}`);
  }
  if (context.opportunity) {
    const { stage, creditAmount, saleAmount, bidAmount } = context.opportunity;
    lines.push(
      `Oportunidade: estágio=${stage ?? "desconhecido"}` +
        (creditAmount ? `, crédito=${creditAmount}` : "") +
        (saleAmount ? `, valor de venda=${saleAmount}` : "") +
        (bidAmount ? `, lance=${bidAmount}` : "")
    );
  }
  if (context.recentMessages.length > 0) {
    lines.push(
      "Últimas mensagens da conversa:",
      ...context.recentMessages.map((m) => `[${m.role}] ${m.content}`)
    );
  }
  return lines.join("\n");
}

// Follow-up direto da tarefa: generates (or reuses) the AI-suggested
// message shown editable in the task panel. Every failure mode — model
// error, empty response — falls back to a safe generic message rather than
// blocking the attendant from sending something.
export async function generateTaskFollowupSuggestion(
  params: GenerateTaskFollowupSuggestionParams
): Promise<TaskFollowupSuggestionResult> {
  if (params.task.type === "libera_cred_resumption" && params.reuseTaskDescriptionIfLiberaCred) {
    return { message: params.task.description };
  }

  try {
    const model = createModel(params.provider, params.model, params.apiKey);
    const result = await generateObject({
      model,
      schema: suggestionSchema,
      system: buildTaskFollowupSystemPrompt(),
      prompt: buildUserPrompt(params),
      abortSignal: AbortSignal.timeout(30_000),
    });

    const usage = extractTokenUsage(result.usage);
    const db = getAdminClient();
    await recordAiUsageEvent(db, {
      organizationId: params.organizationId,
      agentId: params.agentId,
      source: "task_followup_suggestion",
      model: params.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });

    const message = result.object.message?.trim();
    return { message: message || FALLBACK_MESSAGE };
  } catch (err) {
    console.error("Task followup suggestion generation failed, using safe fallback:", err);
    return { message: FALLBACK_MESSAGE };
  }
}
