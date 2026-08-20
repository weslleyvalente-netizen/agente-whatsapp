import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@aula-agente/database";
import {
  getAgentById,
  getAgentConfigIfExists,
  buildDefaultAgentConfigDraft,
  getTrainerMessages,
  getRecentMessagesForOrganization,
  recordAiUsageEvent,
} from "@aula-agente/database";
import { createModel, resolveApiKey, extractTokenUsage, type TokenUsage } from "@aula-agente/agent-runtime";
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

// Bounds how much conversation history can be joined into the stage-1
// prompt. Even with the query's conversationLimit/sinceISO bounds, a busy
// org can produce thousands of messages in a 14-day window; without a
// character budget that would silently overflow the model's context on
// any request that opts into conversation analysis and turn a normal
// request into a hard failure.
const MAX_CONVERSATION_CONTEXT_CHARS = 8000;

export async function buildConversationPatternContext(db: SupabaseClient, organizationId: string): Promise<string> {
  const sinceISO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const messages = await getRecentMessagesForOrganization(db, organizationId, { conversationLimit: 50, sinceISO });
  const lines = messages.map((m) => `[${m.conversation_id.slice(0, 8)}] ${m.role}: ${redactPii(m.content)}`);
  return truncateToMostRecent(lines, MAX_CONVERSATION_CONTEXT_CHARS);
}

// Keeps whichever suffix of `lines` fits within `maxChars` — the messages
// query orders ascending by created_at, so the suffix is the most recent
// messages. Drops whole lines from the oldest end rather than cutting a
// line in half, so the joined context is always readable.
function truncateToMostRecent(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const addedChars = line.length + (kept.length > 0 ? 1 : 0); // +1 accounts for the eventual "\n" join
    if (total + addedChars > maxChars) break;
    kept.unshift(line);
    total += addedChars;
  }
  return kept.join("\n");
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
  userMessage: string,
  analyzeConversations = false
): Promise<{ content: string; proposals: TrainerProposal[] }> {
  const agent = await getAgentById(db, agentId);
  // Deliberately NOT getOrCreateAgentConfig: that one INSERTs a row when the
  // agent has no draft yet, and proposal generation must never write. An
  // agent with no draft row simply reads from an in-memory default built
  // from the same values the row would have been seeded with.
  const draft = (await getAgentConfigIfExists(db, agentId)) ?? buildDefaultAgentConfigDraft(agent);
  const history = await getTrainerMessages(db, sessionId);
  const apiKey = await resolveApiKey(agent.organization_id, agent.provider);
  const model = createModel(agent.provider, agent.model, apiKey);

  // Explicit, structural opt-in from the client (the "Analisar conversas
  // reais" quick action) — never sniffed out of the message text. Sniffing
  // for "conversa" both missed reworded requests (answering as if it had
  // analysed real data when it hadn't) and silently triggered a 50-
  // conversation scan on any message that happened to use the word.
  const conversationContext = analyzeConversations ? await buildConversationPatternContext(db, agent.organization_id) : null;

  const stageOne = await generateObject({
    model,
    schema: trainerReplyGenSchema,
    prompt: buildStageOnePrompt({ agentName: agent.name, draft, conversationContext, history, userMessage }),
  });

  // Conflicted candidates short-circuit with no stage-2 call. Conflict-free
  // candidates each need their own stage-2 generation call; those are
  // independent of one another, so they're fanned out with Promise.all
  // instead of a serial loop (mirroring import-suggestion.service.ts's
  // per-section fan-out) to keep latency from scaling with candidate count.
  // Promise.all preserves result order to match `candidates`' order
  // regardless of resolution order, and a failure in one candidate's
  // stage-2 call/parse is caught locally so it degrades that one proposal
  // instead of discarding stageOne.object.content and every other proposal.
  const built = await Promise.all(
    stageOne.object.candidates.map((candidate) => buildProposalForCandidate(model, draft, userMessage, candidate))
  );
  const proposals: TrainerProposal[] = built.map((b) => b.proposal);

  // Best-effort: a turn's worth of cost (stage-1 + every stage-2 call,
  // summed into one event) is logged for the cost dashboard, but a failure
  // here must never break the reply the user is waiting on.
  const totalUsage = built.reduce(
    (sum, b) => ({
      inputTokens: sum.inputTokens + b.usage.inputTokens,
      outputTokens: sum.outputTokens + b.usage.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + b.usage.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + b.usage.cacheWriteTokens,
    }),
    extractTokenUsage(stageOne.usage)
  );
  recordAiUsageEvent(db, {
    organizationId: agent.organization_id,
    agentId: agent.id,
    source: "trainer",
    model: agent.model,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cacheReadTokens: totalUsage.cacheReadTokens,
    cacheWriteTokens: totalUsage.cacheWriteTokens,
  }).catch((err) => console.error("[trainer] failed to record ai_usage_event", err));

  return { content: stageOne.object.content, proposals };
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

async function buildProposalForCandidate(
  model: ReturnType<typeof createModel>,
  draft: AgentConfigDraft,
  userMessage: string,
  candidate: z.infer<typeof trainerReplyGenSchema>["candidates"][number]
): Promise<{ proposal: TrainerProposal; usage: TokenUsage }> {
  if (candidate.conflicts.length > 0) {
    return {
      usage: ZERO_USAGE,
      proposal: {
        id: randomUUID(),
        section: candidate.section,
        item: candidate.item,
        summary: candidate.summary,
        rationale: candidate.rationale,
        conflicts: candidate.conflicts.map((c) => ({ ...c, section: candidate.section, item: candidate.item })),
        diff: [],
        patch: null,
        status: "proposed",
      },
    };
  }

  const draftKey = SECTION_TO_DRAFT_KEY[candidate.section];
  const before = draft[draftKey];

  try {
    const stageTwo = await generateObject({
      model,
      schema: SECTION_GEN_SCHEMA[candidate.section],
      prompt: buildStageTwoPrompt(candidate.section, before, userMessage, candidate.summary),
    });
    const after = stageTwo.object;
    const patch = updateAgentConfigSchema.parse({ [draftKey]: after });

    return {
      usage: extractTokenUsage(stageTwo.usage),
      proposal: {
        id: randomUUID(),
        section: candidate.section,
        item: candidate.item,
        summary: candidate.summary,
        rationale: candidate.rationale,
        conflicts: [],
        diff: diffSectionValues(before, after),
        patch,
        status: "proposed",
      },
    };
  } catch {
    // Stage-2 generation or schema validation failed for this candidate
    // alone (e.g. the model emitted an invalid section shape). Degrade
    // gracefully to a proposal the user can see and retry, rather than
    // letting the rejection propagate out of proposeConfigChange and
    // discard stageOne.object.content plus every other candidate's
    // already-built proposal.
    return {
      usage: ZERO_USAGE,
      proposal: {
        id: randomUUID(),
        section: candidate.section,
        item: candidate.item,
        summary: candidate.summary,
        rationale: candidate.rationale,
        conflicts: [
          {
            description: "Não foi possível gerar essa mudança automaticamente. Tente reformular o pedido.",
            section: candidate.section,
            item: candidate.item,
            resolution_options: ["Tentar novamente com outra descrição"],
          },
        ],
        diff: [],
        patch: null,
        status: "proposed",
      },
    };
  }
}
