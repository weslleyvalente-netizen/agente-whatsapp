import { z } from "zod";

export const toolsConfigSchema = z.object({
  search_knowledge: z.boolean().default(true),
  search_faq: z.boolean().default(true),
  send_catalog_photo: z.boolean().default(false),
});

export const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  system_prompt: z.string().min(1).max(10000),
  model: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "google"]),
  temperature: z.number().min(0).max(2).default(0.7),
  max_tokens: z.number().int().min(1).max(16384).default(1024),
  tools_config: toolsConfigSchema.default({ search_knowledge: true, search_faq: true, send_catalog_photo: false }),
});

export const updateAgentSchema = createAgentSchema.partial();
