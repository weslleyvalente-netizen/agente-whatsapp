import type { LLMProvider } from "./organization.js";

export interface Agent {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  provider: LLMProvider;
  temperature: number;
  max_tokens: number;
  tools_config: ToolsConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FollowupAutomaticoConfig {
  ativo: boolean;
  primeiro_followup_horas: number;
  segundo_followup_horas: number;
}

export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
  create_task: boolean;
  // Optional: rows written before this feature shipped don't have this key.
  // Every reader must fall back to DEFAULT_FOLLOWUP_AUTOMATICO.
  followup_automatico?: FollowupAutomaticoConfig;
}
