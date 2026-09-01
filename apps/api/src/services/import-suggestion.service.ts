import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, recordAiUsageEvent } from "@aula-agente/database";
import { createModel, resolveApiKey, extractTokenUsage } from "@aula-agente/agent-runtime";
import type { AgentConfigSections, AgentIdentity, AgentPersonality, AgentRules, AgentKnowledgeConfig, AgentPlaybook } from "@aula-agente/shared";

// The shared importSuggestionSchema (packages/shared) reuses the PATCH
// schemas, which mark nearly every field `.default(...)` for partial-update
// ergonomics. Two real, separate Anthropic structured-output limits ruled
// out sending it as one combined schema in one generateObject call:
// (1) "too many optional parameters" (>24) — fixed by using required-only
// generation schemas below — and (2) even with 0 optional fields, "the
// compiled grammar is too large" for the FULL 5-section schema in one call.
// Fix for (2): one generateObject call per section, each with a small,
// focused schema — run in parallel, then assembled into AgentConfigSections.
const ruleItemGenSchema = z.object({
  id: z.string().min(1),
  label: z.string().max(150),
  instrucao: z.string().max(1000),
  ativo: z.boolean(),
});

const typeRuleItemGenSchema = z.object({
  id: z.string().min(1),
  categoria: z.string().max(100),
  instrucao: z.string().max(2000),
  ativo: z.boolean(),
});

const objecaoGenSchema = z.object({
  id: z.string().min(1),
  nome: z.string().max(150),
  como_identificar: z.string().max(1000),
  orientacao: z.string().max(2000),
  pergunta_diagnostico: z.string().max(500),
  quando_escalar: z.string().max(500),
  ativo: z.boolean(),
});

const linkItemGenSchema = z.object({
  id: z.string().min(1),
  titulo: z.string().max(150),
  url: z.string().url(),
  ativo: z.boolean(),
});

export const identityGenSchema = z.object({
  nome: z.string().max(100),
  funcao: z.string().max(200),
  missao: z.string().max(2000),
});

export const personalityGenSchema = z.object({
  tom_de_voz: z.enum(["profissional", "equilibrado", "amigavel", "divertido", "personalizado"]),
  tom_de_voz_personalizado: z.string().max(500),
  tamanho_resposta: z.enum(["curta", "media", "detalhada"]),
  emojis: z.object({
    ativo: z.boolean(),
    maximo: z.number().int().min(0).max(5),
    instrucao: z.string().max(500),
  }),
  perguntas_por_vez: z.object({
    maximo: z.number().int().min(1).max(5),
  }),
  postura_comercial: z.object({
    tipo: z.string().max(100),
    instrucao: z.string().max(1000),
  }),
  girias_proibidas: z.array(z.string().max(100)),
  proatividade: z.string().max(2000),
});

export const rulesGenSchema = z.object({
  transferencia_para_humano: z.array(ruleItemGenSchema),
  promessas_proibidas: z.array(ruleItemGenSchema),
  regras_por_tipo: z.array(typeRuleItemGenSchema),
  preco_desconto: z.object({
    pode_autonomo: z.string().max(2000),
    exige_humano: z.string().max(2000),
    nunca_pode: z.string().max(2000),
    observacoes: z.string().max(2000),
  }),
  objecoes: z.array(objecaoGenSchema),
});

export const knowledgeGenSchema = z.object({
  precos_notas: z.string().max(4000),
  links: z.array(linkItemGenSchema),
  documentos_ativos: z.boolean(),
  faqs_ativas: z.boolean(),
});

export const playbookGenSchema = z.object({
  script_atendimento: z.string().max(10000),
});

const COMMON_PREAMBLE =
  "Preserve o significado original — não invente informações que não estejam no texto. Se não houver conteúdo correspondente, deixe os campos vazios (string vazia, array vazio, ou false), nunca omita um campo.";

function buildPrompt(agentName: string, systemPrompt: string, sectionInstruction: string): string {
  return [
    `Você vai analisar o texto de configuração (system prompt) abaixo de um agente de atendimento via WhatsApp chamado "${agentName}" e extrair APENAS a seção pedida.`,
    "",
    sectionInstruction,
    "",
    COMMON_PREAMBLE,
    "",
    "Texto atual:",
    systemPrompt,
  ].join("\n");
}

export async function suggestConfigFromSystemPrompt(db: SupabaseClient, agentId: string): Promise<AgentConfigSections> {
  const agent = await getAgentById(db, agentId);
  const apiKey = await resolveApiKey(agent.organization_id, agent.provider);
  const model = createModel(agent.provider, agent.model, apiKey);

  const [identityResult, personalityResult, rulesResult, knowledgeResult, playbookResult] = await Promise.all([
    generateObject({
      model,
      schema: identityGenSchema,
      prompt: buildPrompt(agent.name, agent.system_prompt, "Extraia: identity (nome, função, missão/instruções principais)."),
    }),
    generateObject({
      model,
      schema: personalityGenSchema,
      prompt: buildPrompt(
        agent.name,
        agent.system_prompt,
        "Extraia: personality (tom de voz, tamanho das respostas, regras de emoji, máximo de perguntas por mensagem, postura comercial, gírias proibidas, regras de proatividade)."
      ),
    }),
    generateObject({
      model,
      schema: rulesGenSchema,
      prompt: buildPrompt(
        agent.name,
        agent.system_prompt,
        "Extraia: rules (gatilhos de transferência para humano, promessas proibidas, regras por tipo de atendimento, política de preço e desconto, e objeções comuns já descritas no texto)."
      ),
    }),
    generateObject({
      model,
      schema: knowledgeGenSchema,
      prompt: buildPrompt(agent.name, agent.system_prompt, "Extraia: knowledge (notas de preço e links úteis mencionados no texto — não invente links)."),
    }),
    generateObject({
      model,
      schema: playbookGenSchema,
      prompt: buildPrompt(
        agent.name,
        agent.system_prompt,
        "Extraia: playbook (o fluxo processual de atendimento — identificação, qualificação, direcionamento, próximo passo — se descrito)."
      ),
    }),
  ]);

  // Best-effort: five section calls' worth of cost, summed into one event,
  // logged for the cost dashboard — a failure here must never break the
  // suggestion the user is waiting on.
  const totalUsage = [identityResult, personalityResult, rulesResult, knowledgeResult, playbookResult]
    .map((r) => extractTokenUsage(r.usage))
    .reduce((sum, u) => ({
      inputTokens: sum.inputTokens + u.inputTokens,
      outputTokens: sum.outputTokens + u.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + u.cacheWriteTokens,
    }));
  recordAiUsageEvent(db, {
    organizationId: agent.organization_id,
    agentId: agent.id,
    source: "import_suggestion",
    model: agent.model,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cacheReadTokens: totalUsage.cacheReadTokens,
    cacheWriteTokens: totalUsage.cacheWriteTokens,
  }).catch((err) => console.error("[import-suggestion] failed to record ai_usage_event", err));

  return {
    identity: identityResult.object as AgentIdentity,
    personality: personalityResult.object as AgentPersonality,
    rules: rulesResult.object as AgentRules,
    knowledge: knowledgeResult.object as AgentKnowledgeConfig,
    playbook: playbookResult.object as AgentPlaybook,
  };
}
