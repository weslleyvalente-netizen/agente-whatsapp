import { z } from "zod";
import { toolsConfigSchema } from "./agent.js";

export const agentIdentitySchema = z.object({
  nome: z.string().max(100).default(""),
  funcao: z.string().max(200).default(""),
  missao: z.string().max(2000).default(""),
});

export const agentEmojisConfigSchema = z.object({
  ativo: z.boolean().default(true),
  maximo: z.number().int().min(0).max(5).default(1),
  instrucao: z.string().max(500).default(""),
});

export const agentPerguntasPorVezConfigSchema = z.object({
  maximo: z.number().int().min(1).max(5).default(1),
});

export const agentPosturaComercialConfigSchema = z.object({
  tipo: z.string().max(100).default(""),
  instrucao: z.string().max(1000).default(""),
});

export const agentPersonalitySchema = z.object({
  tom_de_voz: z.enum(["profissional", "equilibrado", "amigavel", "divertido", "personalizado"]).default("equilibrado"),
  tom_de_voz_personalizado: z.string().max(500).default(""),
  tamanho_resposta: z.enum(["curta", "media", "detalhada"]).default("curta"),
  emojis: agentEmojisConfigSchema.default({ ativo: true, maximo: 1, instrucao: "" }),
  perguntas_por_vez: agentPerguntasPorVezConfigSchema.default({ maximo: 1 }),
  postura_comercial: agentPosturaComercialConfigSchema.default({ tipo: "", instrucao: "" }),
  girias_proibidas: z.array(z.string().max(100)).default([]),
  proatividade: z.string().max(2000).default(""),
});

export const agentRuleItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().max(150),
  instrucao: z.string().max(1000),
  ativo: z.boolean().default(true),
});

export const agentTypeRuleItemSchema = z.object({
  id: z.string().min(1),
  categoria: z.string().max(100),
  instrucao: z.string().max(2000),
  ativo: z.boolean().default(true),
});

export const agentPrecoDescontoSchema = z.object({
  pode_autonomo: z.string().max(2000).default(""),
  exige_humano: z.string().max(2000).default(""),
  nunca_pode: z.string().max(2000).default(""),
  observacoes: z.string().max(2000).default(""),
});

export const agentObjecaoSchema = z.object({
  id: z.string().min(1),
  nome: z.string().max(150),
  como_identificar: z.string().max(1000).default(""),
  orientacao: z.string().max(2000).default(""),
  pergunta_diagnostico: z.string().max(500).default(""),
  quando_escalar: z.string().max(500).default(""),
  ativo: z.boolean().default(true),
});

export const agentRulesSchema = z.object({
  transferencia_para_humano: z.array(agentRuleItemSchema).default([]),
  promessas_proibidas: z.array(agentRuleItemSchema).default([]),
  regras_por_tipo: z.array(agentTypeRuleItemSchema).default([]),
  preco_desconto: agentPrecoDescontoSchema.default({
    pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "",
  }),
  objecoes: z.array(agentObjecaoSchema).default([]),
});

export const agentLinkItemSchema = z.object({
  id: z.string().min(1),
  titulo: z.string().max(150),
  url: z.string().url(),
  ativo: z.boolean().default(true),
});

export const agentKnowledgeConfigSchema = z.object({
  precos_notas: z.string().max(4000).default(""),
  links: z.array(agentLinkItemSchema).default([]),
  documentos_ativos: z.boolean().default(true),
  faqs_ativas: z.boolean().default(true),
});

export const agentPlaybookSchema = z.object({
  script_atendimento: z.string().max(10000).default(""),
});

export const agentModelSettingsSchema = z.object({
  provider: z.enum(["openai", "anthropic", "google"]),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().min(1).max(16384),
});

export const updateAgentConfigSchema = z.object({
  identity: agentIdentitySchema.optional(),
  personality: agentPersonalitySchema.optional(),
  rules: agentRulesSchema.optional(),
  knowledge: agentKnowledgeConfigSchema.optional(),
  playbook: agentPlaybookSchema.optional(),
  tools_config: toolsConfigSchema.optional(),
  model_settings: agentModelSettingsSchema.optional(),
});

export const publishAgentConfigSchema = z.object({
  changelog: z.string().min(1).max(1000),
});
