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

export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
}
