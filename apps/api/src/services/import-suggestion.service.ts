import { generateObject } from "ai";
import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById } from "@aula-agente/database";
import { createModel, resolveApiKey } from "@aula-agente/agent-runtime";
import { importSuggestionSchema } from "@aula-agente/shared";
import type { AgentConfigSections } from "@aula-agente/shared";

export async function suggestConfigFromSystemPrompt(db: SupabaseClient, agentId: string): Promise<AgentConfigSections> {
  const agent = await getAgentById(db, agentId);
  const apiKey = await resolveApiKey(agent.organization_id, agent.provider);
  const model = createModel(agent.provider, agent.model, apiKey);

  const { object } = await generateObject({
    model,
    schema: importSuggestionSchema,
    prompt: [
      `Você vai analisar o texto de configuração (system prompt) abaixo de um agente de atendimento via WhatsApp chamado "${agent.name}" e sugerir como dividir esse conteúdo em seções estruturadas.`,
      "",
      "- identity: nome, função e missão/instruções principais.",
      "- personality: tom de voz, tamanho das respostas, regras de emoji, máximo de perguntas por mensagem, postura comercial, gírias proibidas, e regras de proatividade.",
      "- rules: gatilhos de transferência para humano, promessas proibidas, regras por tipo de atendimento, política de preço e desconto, e objeções comuns já descritas no texto.",
      "- knowledge: notas de preço e links úteis mencionados no texto (não invente links).",
      "- playbook: o fluxo processual de atendimento (identificação, qualificação, direcionamento, próximo passo), se descrito.",
      "",
      "Preserve o significado original — não invente informações que não estejam no texto. Se uma seção não tiver conteúdo correspondente, deixe os campos vazios ou com os valores padrão.",
      "",
      "Texto atual:",
      agent.system_prompt,
    ].join("\n"),
  });

  return object;
}
