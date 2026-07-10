import type { ToolsConfig } from "@aula-agente/shared";
import { createSearchKnowledgeTool } from "./search-knowledge";
import { createSearchFaqTool } from "./search-faq";

interface RegistryParams {
  organizationId: string;
  agentId: string;
  toolsConfig: ToolsConfig;
  apiKey: string;
}

export function buildToolsForAgent(params: RegistryParams) {
  const { organizationId, agentId, toolsConfig, apiKey } = params;
  const tools: Record<string, ReturnType<typeof createSearchKnowledgeTool>> = {};

  if (toolsConfig.search_knowledge) {
    tools.searchKnowledge = createSearchKnowledgeTool(organizationId, agentId, apiKey);
  }

  if (toolsConfig.search_faq) {
    tools.searchFaq = createSearchFaqTool(agentId);
  }

  return tools;
}
