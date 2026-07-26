import type { LLMProvider } from "./organization.js";
import type { ToolsConfig } from "./agent.js";

export type TomDeVoz = "profissional" | "equilibrado" | "amigavel" | "divertido" | "personalizado";
export type TamanhoResposta = "curta" | "media" | "detalhada";

export interface AgentIdentity {
  nome: string;
  funcao: string;
  missao: string;
}

export interface AgentEmojisConfig {
  ativo: boolean;
  maximo: number;
  instrucao: string;
}

export interface AgentPerguntasPorVezConfig {
  maximo: number;
}

export interface AgentPosturaComercialConfig {
  tipo: string;
  instrucao: string;
}

export interface AgentPersonality {
  tom_de_voz: TomDeVoz;
  tom_de_voz_personalizado: string;
  tamanho_resposta: TamanhoResposta;
  emojis: AgentEmojisConfig;
  perguntas_por_vez: AgentPerguntasPorVezConfig;
  postura_comercial: AgentPosturaComercialConfig;
  girias_proibidas: string[];
  proatividade: string;
}

export interface AgentRuleItem {
  id: string;
  label: string;
  instrucao: string;
  ativo: boolean;
}

export interface AgentTypeRuleItem {
  id: string;
  categoria: string;
  instrucao: string;
  ativo: boolean;
}

export interface AgentPrecoDesconto {
  pode_autonomo: string;
  exige_humano: string;
  nunca_pode: string;
  observacoes: string;
}

export interface AgentObjecao {
  id: string;
  nome: string;
  como_identificar: string;
  orientacao: string;
  pergunta_diagnostico: string;
  quando_escalar: string;
  ativo: boolean;
}

export interface AgentRules {
  transferencia_para_humano: AgentRuleItem[];
  promessas_proibidas: AgentRuleItem[];
  regras_por_tipo: AgentTypeRuleItem[];
  preco_desconto: AgentPrecoDesconto;
  objecoes: AgentObjecao[];
}

export interface AgentLinkItem {
  id: string;
  titulo: string;
  url: string;
  ativo: boolean;
}

export interface AgentKnowledgeConfig {
  precos_notas: string;
  links: AgentLinkItem[];
  documentos_ativos: boolean;
  faqs_ativas: boolean;
}

export interface AgentPlaybook {
  script_atendimento: string;
}

export interface AgentModelSettings {
  provider: LLMProvider;
  model: string;
  temperature: number;
  max_tokens: number;
}

export interface AgentConfigSections {
  identity: AgentIdentity;
  personality: AgentPersonality;
  rules: AgentRules;
  knowledge: AgentKnowledgeConfig;
  playbook: AgentPlaybook;
}

export interface AgentConfigDraft extends AgentConfigSections {
  id: string;
  agent_id: string;
  organization_id: string;
  base_version_id: string | null;
  tools_config: ToolsConfig;
  model_settings: AgentModelSettings;
  updated_at: string;
  updated_by: string | null;
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  organization_id: string;
  version: number;
  changelog: string;
  config_snapshot: AgentConfigSections;
  compiled_system_prompt: string;
  model_settings: AgentModelSettings;
  tools_config: ToolsConfig;
  published_by: string;
  created_at: string;
}

export interface PlaygroundToolCall {
  tool_name: string;
  input: unknown;
  output: unknown;
  mode: "real" | "simulated";
  executed_at: string;
}

export interface AgentPlaygroundSession {
  id: string;
  agent_id: string;
  organization_id: string;
  created_by: string;
  created_at: string;
}

export interface AgentPlaygroundMessage {
  id: string;
  session_id: string;
  organization_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: PlaygroundToolCall[];
  created_at: string;
}
