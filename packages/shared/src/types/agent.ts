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
  // Business-hours window for sending automatic follow-ups, in the
  // America/Sao_Paulo time zone. Optional: rows written before this existed
  // fall back to DEFAULT_FOLLOWUP_AUTOMATICO's 8-18 default. Outside the
  // window a due follow-up is skipped for that tick, not lost — it fires on
  // the next in-window tick (stale-conversation-followup.ts runs every 15
  // min and re-evaluates from scratch each time).
  janela_inicio_hora?: number;
  janela_fim_hora?: number;
}

export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
  create_task: boolean;
  update_qualification: boolean;
  // Optional: rows written before this feature shipped don't have this key.
  // Every reader must fall back to DEFAULT_FOLLOWUP_AUTOMATICO.
  followup_automatico?: FollowupAutomaticoConfig;
  audio_replies: boolean;
  audio_voice: string;
}
