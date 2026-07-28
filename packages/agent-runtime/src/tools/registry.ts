import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolsConfig } from "@aula-agente/shared";
import { TASK_TYPES, TASK_PRIORITIES } from "@aula-agente/shared";
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
  sandbox?: boolean;
}

function createMockCreateTaskTool() {
  return tool({
    description:
      "Simula a criação de uma tarefa de follow-up comercial. Estamos no Playground de testes — nada é gravado de verdade.",
    inputSchema: z.object({
      type: z.enum(TASK_TYPES),
      description: z.string(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      priority: z.enum(TASK_PRIORITIES).default("normal"),
      reason: z.string(),
    }),
    execute: async ({ description, due_date }) => {
      return `[SIMULADO] Tarefa seria criada: "${description}" para ${due_date}.`;
    },
  });
}

function createMockSendVehiclePhotoTool() {
  return tool({
    description:
      "Simula o envio de uma foto de veículo pelo WhatsApp. Estamos no Playground de testes — nenhuma mensagem real é enviada.",
    inputSchema: z.object({ model: z.string() }),
    execute: async ({ model }) => {
      return `[SIMULADO] Foto de "${model}" seria enviada pelo WhatsApp agora.`;
    },
  });
}

export function buildToolsForAgent(params: RegistryParams): ToolSet {
  const { organizationId, agentId, toolsConfig, apiKey, conversationId, instanceId, phone, contactId, sandbox } = params;
  const tools: ToolSet = {};

  if (toolsConfig.search_knowledge) {
    tools.searchKnowledge = createSearchKnowledgeTool(organizationId, agentId, apiKey);
  }

  if (toolsConfig.search_faq) {
    tools.searchFaq = createSearchFaqTool(agentId);
  }

  if (toolsConfig.send_catalog_photo) {
    tools.searchCatalog = createSearchCatalogTool();
    tools.sendVehiclePhoto = sandbox
      ? createMockSendVehiclePhotoTool()
      : createSendVehiclePhotoTool({ conversationId, organizationId, instanceId, phone });
  }

  if (toolsConfig.create_task) {
    tools.createTask = sandbox
      ? createMockCreateTaskTool()
      : createCreateTaskTool({ contactId, conversationId, organizationId });
  }

  return markLastToolCacheable(tools);
}

// Anthropic's prompt cache_control is a prefix marker: caching it on the
// last tool definition caches every tool definition before it too, as one
// contiguous block — no need to mark each tool individually. Which tool
// ends up last depends on toolsConfig, so this is resolved after all the
// conditional registration above rather than hardcoded to one tool name.
// The tool set only changes when someone edits Configurações, so this
// block is static across every message of every conversation for an agent.
function markLastToolCacheable(tools: ToolSet): ToolSet {
  const names = Object.keys(tools);
  if (names.length === 0) return tools;
  const lastName = names[names.length - 1];
  const lastTool = tools[lastName];
  return {
    ...tools,
    [lastName]: {
      ...lastTool,
      providerOptions: {
        ...lastTool.providerOptions,
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
  };
}
