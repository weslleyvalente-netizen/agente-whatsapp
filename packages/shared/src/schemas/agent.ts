import { z } from "zod";
import { DEFAULT_FOLLOWUP_AUTOMATICO } from "../constants.js";

export const followupAutomaticoConfigSchema = z.object({
  ativo: z.boolean().default(DEFAULT_FOLLOWUP_AUTOMATICO.ativo),
  primeiro_followup_horas: z.number().min(0.5).max(168).default(DEFAULT_FOLLOWUP_AUTOMATICO.primeiro_followup_horas),
  segundo_followup_horas: z.number().min(0.5).max(168).default(DEFAULT_FOLLOWUP_AUTOMATICO.segundo_followup_horas),
});

export const toolsConfigSchema = z.object({
  search_knowledge: z.boolean().default(true),
  search_faq: z.boolean().default(true),
  send_catalog_photo: z.boolean().default(false),
  create_task: z.boolean().default(false),
  update_qualification: z.boolean().default(false),
  // Reuses the same literal as followupAutomaticoConfigSchema's own
  // per-field defaults above (both sourced from DEFAULT_FOLLOWUP_AUTOMATICO)
  // so a future change to the windows can't update one and silently miss
  // the other.
  followup_automatico: followupAutomaticoConfigSchema.default(DEFAULT_FOLLOWUP_AUTOMATICO),
});

export const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  system_prompt: z.string().min(1).max(10000),
  model: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "google"]),
  temperature: z.number().min(0).max(2).default(0.7),
  max_tokens: z.number().int().min(1).max(16384).default(1024),
  tools_config: toolsConfigSchema.default({
    search_knowledge: true,
    search_faq: true,
    send_catalog_photo: false,
    create_task: false,
    update_qualification: false,
  }),
});

export const updateAgentSchema = createAgentSchema.partial();
