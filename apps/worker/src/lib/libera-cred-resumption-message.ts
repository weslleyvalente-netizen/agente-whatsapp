import { embed, generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { createModel, resolveApiKey } from "@aula-agente/agent-runtime";
import { getAdminClient, searchKnowledgeChunks, getKnowledgeChunksWithDocumentMeta } from "@aula-agente/database";
import { isLiberaCredTableOutdated, type LLMProvider } from "@aula-agente/shared";

export function buildLiberaCredTableSearchQuery(): string {
  return "tabela de planos e prazos vigente do LiberaCred, valores, taxas, prazos";
}

export function buildLiberaCredSuggestionSystemPrompt(): string {
  return (
    "Você ajuda uma atendente de uma loja a retomar contato com um cliente que já recebeu " +
    "uma proposta de plano do LiberaCred, mas ainda não decidiu. Escreva uma mensagem curta " +
    "e natural, em português, para a ATENDENTE enviar manualmente — você não está enviando " +
    "nada ao cliente agora, só sugerindo o texto. Use APENAS valores, taxas e prazos que " +
    "aparecem literalmente nos trechos da tabela fornecidos — nunca calcule, estime ou " +
    "invente um número que não esteja escrito. Se o texto mencionar uma data de vigência da " +
    "tabela, extraia essa data em table_date_found_in_text no formato YYYY-MM-DD; se não " +
    "houver data explícita, deixe null. Se os trechos fornecidos não tiverem informação " +
    "suficiente sobre planos/valores do LiberaCred, responda com message=null e " +
    "table_found=false — nunca invente um plano genérico."
  );
}

// Never invents a value — this is what a task shows instead of a ready
// message whenever the table can't be confirmed fresh (item 5a).
export function buildOutdatedWarning(): string {
  return (
    "⚠️ Tabela de planos LiberaCred não encontrada ou desatualizada na base de conhecimento " +
    "— confirme os valores manualmente antes de enviar qualquer proposta ao cliente."
  );
}

const suggestionSchema = z.object({
  message: z.string().nullable(),
  table_date_found_in_text: z.string().nullable(),
  table_found: z.boolean(),
});

export interface GenerateLiberaCredResumptionSuggestionParams {
  organizationId: string;
  agentId: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  tableMaxAgeDays: number;
  todayISODate: string;
}

export interface LiberaCredSuggestionResult {
  description: string;
  outdated: boolean;
}

// Fase 2, item 5(a): builds the task description for a LiberaCred
// resumption suggestion — either a ready-to-copy message grounded in the
// knowledge base's own plan table (never estimated), or a warning that the
// table couldn't be confirmed fresh. Every failure mode (no knowledge base
// hit, generation error, no table_found, no explicit/fresh date) falls back
// to the warning — this function is only ever wrong in the safe direction.
export async function generateLiberaCredResumptionSuggestion(
  params: GenerateLiberaCredResumptionSuggestionParams
): Promise<LiberaCredSuggestionResult> {
  const db = getAdminClient();

  let chunks: Awaited<ReturnType<typeof getKnowledgeChunksWithDocumentMeta>> = [];
  try {
    const openaiApiKey = await resolveApiKey(params.organizationId, "openai");
    const openai = createOpenAI({ apiKey: openaiApiKey });
    const { embedding } = await embed({
      model: openai.embedding("text-embedding-3-small"),
      value: buildLiberaCredTableSearchQuery(),
    });
    const hits = await searchKnowledgeChunks(db, params.organizationId, params.agentId, embedding, 5);
    chunks = await getKnowledgeChunksWithDocumentMeta(
      db,
      hits.map((h) => h.id)
    );
  } catch (err) {
    console.error("LiberaCred resumption: knowledge search failed, treating table as not found:", err);
  }

  if (chunks.length === 0) {
    return { description: buildOutdatedWarning(), outdated: true };
  }

  let suggestion: z.infer<typeof suggestionSchema>;
  try {
    const model = createModel(params.provider, params.model, params.apiKey);
    const chunkText = chunks.map((c) => `[${c.document_title}]\n${c.content}`).join("\n\n---\n\n");
    const result = await generateObject({
      model,
      schema: suggestionSchema,
      system: buildLiberaCredSuggestionSystemPrompt(),
      prompt: chunkText,
      abortSignal: AbortSignal.timeout(30_000),
    });
    suggestion = result.object;
  } catch (err) {
    console.error("LiberaCred resumption: message generation failed, treating table as not found:", err);
    return { description: buildOutdatedWarning(), outdated: true };
  }

  const documentUpdatedAt = chunks[0]?.document_updated_at || null;
  const outdated =
    !suggestion.table_found ||
    !suggestion.message ||
    isLiberaCredTableOutdated(
      suggestion.table_date_found_in_text,
      documentUpdatedAt,
      params.todayISODate,
      params.tableMaxAgeDays
    );

  if (outdated || !suggestion.message) {
    return { description: buildOutdatedWarning(), outdated: true };
  }

  const dateNote = suggestion.table_date_found_in_text
    ? ` (tabela vigente em ${suggestion.table_date_found_in_text})`
    : documentUpdatedAt
      ? ` (tabela atualizada em ${documentUpdatedAt.slice(0, 10)})`
      : "";

  return { description: `${suggestion.message}${dateNote}`, outdated: false };
}
