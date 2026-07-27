import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, getOrCreateAgentConfig, getTrainerMessages, getRecentMessagesForOrganization } from "@aula-agente/database";
import { createModel, resolveApiKey } from "@aula-agente/agent-runtime";
import {
  trainerReplyGenSchema,
  updateAgentConfigSchema,
  SECTION_TO_DRAFT_KEY,
  type SectionKey,
  type TrainerProposal,
  type TrainerProposalDiffEntry,
  type AgentTrainerMessage,
  type AgentConfigDraft,
} from "@aula-agente/shared";
import {
  identityGenSchema,
  personalityGenSchema,
  rulesGenSchema,
  knowledgeGenSchema,
  playbookGenSchema,
} from "./import-suggestion.service.js";

const toolsConfigGenSchema = z.object({
  search_knowledge: z.boolean(),
  search_faq: z.boolean(),
  send_catalog_photo: z.boolean(),
  create_task: z.boolean(),
});

const SECTION_GEN_SCHEMA: Record<SectionKey, z.ZodTypeAny> = {
  geral: identityGenSchema,
  personalidade: personalityGenSchema,
  regras: rulesGenSchema,
  conhecimento: knowledgeGenSchema,
  playbooks: playbookGenSchema,
  ferramentas: toolsConfigGenSchema,
};

const SECTION_GEN_INSTRUCTION: Record<SectionKey, string> = {
  geral: "Atualize a seção identity (nome, função, missão) do agente conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  personalidade:
    "Atualize a seção personality (tom de voz, tamanho de resposta, emojis, perguntas por vez, postura comercial, gírias proibidas, proatividade) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  regras:
    "Atualize a seção rules (transferência para humano, promessas proibidas, regras por tipo de atendimento, preço e desconto, objeções) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  conhecimento: "Atualize a seção knowledge (notas de preço, links, flags de documentos/FAQ ativos) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  playbooks: "Atualize a seção playbook (script de atendimento) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  ferramentas: "Atualize a seção tools_config (quais ferramentas o agente pode usar) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
};

const PII_PATTERNS = [
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, // CPF
  /\b(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, // phone
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // email
];

export function redactPii(text: string): string {
  return PII_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redigido]"), text);
}

export async function buildConversationPatternContext(db: SupabaseClient, organizationId: string): Promise<string> {
  const sinceISO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const messages = await getRecentMessagesForOrganization(db, organizationId, { conversationLimit: 50, sinceISO });
  return messages.map((m) => `[${m.conversation_id.slice(0, 8)}] ${m.role}: ${redactPii(m.content)}`).join("\n");
}

// Server-computed diff (not authored by the LLM): recurses into plain
// objects, treats arrays as atomic values, and emits one entry per leaf
// that actually changed. Deterministic, so it's safe to trust for display
// even though the "after" value came from the model.
export function diffSectionValues(before: unknown, after: unknown, prefix = ""): TrainerProposalDiffEntry[] {
  const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  if (!isPlainObject(before) || !isPlainObject(after)) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    return [{ field_path: prefix || "(raiz)", before, after }];
  }

  const entries: TrainerProposalDiffEntry[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    entries.push(...diffSectionValues(before[key], after[key], path));
  }
  return entries;
}

function buildStageOnePrompt(params: {
  agentName: string;
  draft: AgentConfigDraft;
  conversationContext: string | null;
  history: AgentTrainerMessage[];
  userMessage: string;
}): string {
  const sections = {
    identity: params.draft.identity,
    personality: params.draft.personality,
    rules: params.draft.rules,
    knowledge: params.draft.knowledge,
    playbook: params.draft.playbook,
    tools_config: params.draft.tools_config,
  };
  const historyLines = params.history.map((m) => `${m.role === "user" ? "Usuário" : "Trainer"}: ${m.content}`).join("\n");

  return [
    `Você é o Trainer da Helena, um agente de atendimento via WhatsApp chamado "${params.agentName}", conversando com o usuário sobre mudanças na configuração dele.`,
    "",
    'Antes de propor qualquer mudança, verifique se ela contradiz ou duplica algo que já existe no rascunho atual. Se contradiz: não gere uma proposta executável — preencha só "conflicts" com a explicação e as opções de resolução, e faça a pergunta ao usuário em "content". Se duplica algo já existente (uma regra, objeção ou item de conhecimento semelhante): aponte a duplicata em vez de propor um item novo. Nunca invente valor de preço, desconto ou condição comercial que o usuário não disse explicitamente — pergunte antes.',
    "",
    "Rascunho atual completo (JSON):",
    JSON.stringify(sections, null, 2),
    ...(params.conversationContext ? ["", "Padrões observados em conversas reais recentes (já sem dados pessoais):", params.conversationContext] : []),
    ...(historyLines ? ["", "Histórico da conversa com o Trainer até agora:", historyLines] : []),
    "",
    `Mensagem nova do usuário: ${params.userMessage}`,
    "",
    'Para cada mudança pedida, gere um item em "candidates" com a seção afetada (geral, personalidade, regras, conhecimento, playbooks ou ferramentas), o item específico dentro dela quando aplicável, um resumo curto, a justificativa, e a lista de conflitos (vazia se não houver). Se a mensagem for só uma pergunta ou não pedir mudança nenhuma, devolva "candidates" vazio e responda em "content".',
  ].join("\n");
}

function buildStageTwoPrompt(section: SectionKey, currentValue: unknown, userMessage: string, candidateSummary: string): string {
  return [
    SECTION_GEN_INSTRUCTION[section],
    "",
    "Valor atual dessa seção (JSON):",
    JSON.stringify(currentValue, null, 2),
    "",
    `Pedido original do usuário: ${userMessage}`,
    `Resumo da mudança já decidida: ${candidateSummary}`,
    "",
    "Devolva o objeto COMPLETO da seção já com a mudança aplicada — inclua também os campos que não mudaram, copiados exatamente como estão.",
  ].join("\n");
}

export async function proposeConfigChange(
  db: SupabaseClient,
  agentId: string,
  sessionId: string,
  userMessage: string
): Promise<{ content: string; proposals: TrainerProposal[] }> {
  const agent = await getAgentById(db, agentId);
  const draft = await getOrCreateAgentConfig(db, agent);
  const history = await getTrainerMessages(db, sessionId);
  const apiKey = await resolveApiKey(agent.organization_id, agent.provider);
  const model = createModel(agent.provider, agent.model, apiKey);

  const conversationContext = /conversa/i.test(userMessage) ? await buildConversationPatternContext(db, agent.organization_id) : null;

  const stageOne = await generateObject({
    model,
    schema: trainerReplyGenSchema,
    prompt: buildStageOnePrompt({ agentName: agent.name, draft, conversationContext, history, userMessage }),
  });

  const proposals: TrainerProposal[] = [];
  for (const candidate of stageOne.object.candidates) {
    if (candidate.conflicts.length > 0) {
      proposals.push({
        id: randomUUID(),
        section: candidate.section,
        item: candidate.item,
        summary: candidate.summary,
        rationale: candidate.rationale,
        conflicts: candidate.conflicts.map((c) => ({ ...c, section: candidate.section, item: candidate.item })),
        diff: [],
        patch: null,
        status: "proposed",
      });
      continue;
    }

    const draftKey = SECTION_TO_DRAFT_KEY[candidate.section];
    const before = draft[draftKey];
    const stageTwo = await generateObject({
      model,
      schema: SECTION_GEN_SCHEMA[candidate.section],
      prompt: buildStageTwoPrompt(candidate.section, before, userMessage, candidate.summary),
    });
    const after = stageTwo.object;
    const patch = updateAgentConfigSchema.parse({ [draftKey]: after });

    proposals.push({
      id: randomUUID(),
      section: candidate.section,
      item: candidate.item,
      summary: candidate.summary,
      rationale: candidate.rationale,
      conflicts: [],
      diff: diffSectionValues(before, after),
      patch,
      status: "proposed",
    });
  }

  return { content: stageOne.object.content, proposals };
}
