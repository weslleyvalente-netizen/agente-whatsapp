import type { ToolSet } from "ai";
import type { ToolsConfig } from "@aula-agente/shared";
import { createSearchKnowledgeTool } from "./search-knowledge.js";
import { createSearchFaqTool } from "./search-faq.js";
import { createSearchCatalogTool } from "./search-catalog.js";
import { createSendVehiclePhotoTool } from "./send-vehicle-photo.js";
import { createCreateTaskTool } from "./create-task.js";

interface RegistryParams {
  organizationId: string;
  agentId: string;
  toolsConfig: ToolsConfig;
  apiKey: string;
  conversationId: string;
  instanceId: string;
  phone: string;
  contactId: string;
}

export function buildToolsForAgent(params: RegistryParams): ToolSet {
  const { organizationId, agentId, toolsConfig, apiKey, conversationId, instanceId, phone, contactId } = params;
  const tools: ToolSet = {};

  if (toolsConfig.search_knowledge) {
    tools.searchKnowledge = createSearchKnowledgeTool(organizationId, agentId, apiKey);
  }

  if (toolsConfig.search_faq) {
    tools.searchFaq = createSearchFaqTool(agentId);
  }

  if (toolsConfig.send_catalog_photo) {
    tools.searchCatalog = createSearchCatalogTool();
    tools.sendVehiclePhoto = createSendVehiclePhotoTool({ conversationId, organizationId, instanceId, phone });
  }

  if (toolsConfig.create_task) {
    tools.createTask = createCreateTaskTool({ contactId, conversationId, organizationId });
  }

  return tools;
}
