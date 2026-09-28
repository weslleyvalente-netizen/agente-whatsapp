export const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export const ALLOWED_DOCUMENT_TYPES = ["pdf", "txt", "md", "docx", "csv"] as const;

export const ALLOWED_DOCUMENT_MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
};

export const CONVERSATION_STATUSES = ["open", "waiting", "resolved", "closed"] as const;

export const MESSAGE_ROLES = ["contact", "agent", "human_agent", "system"] as const;

export const MEMBER_ROLES = ["owner", "admin", "agent"] as const;

export const LLM_PROVIDERS = ["openai", "anthropic", "google"] as const;

export const TASK_TYPES = [
  "return_customer",
  "request_documents",
  "run_quote",
  "update_quote",
  "awaiting_customer_cpf",
  "awaiting_customer_data",
  "awaiting_customer_decision",
  "scheduled_callback",
  "proposal_followup",
  "financing_followup",
  "consortium_followup",
  "vehicle_followup",
  "customer_unresponsive",
  "stalled_negotiation",
  "libera_cred_resumption",
  "other",
] as const;

export const TASK_TYPE_LABELS: Record<(typeof TASK_TYPES)[number], string> = {
  return_customer: "Retornar cliente",
  request_documents: "Cobrar documentos",
  run_quote: "Fazer simulação",
  update_quote: "Atualizar simulação",
  awaiting_customer_cpf: "Cliente ficou de enviar CPF",
  awaiting_customer_data: "Cliente ficou de enviar dados",
  awaiting_customer_decision: "Cliente ficou de falar com outra pessoa",
  scheduled_callback: "Cliente pediu retorno em determinada data",
  proposal_followup: "Follow-up de proposta",
  financing_followup: "Follow-up de financiamento",
  consortium_followup: "Follow-up de consórcio",
  vehicle_followup: "Follow-up de veículo",
  customer_unresponsive: "Cliente parou de responder",
  stalled_negotiation: "Negociação sem conclusão",
  libera_cred_resumption: "Retomada LiberaCred",
  other: "Outro",
};

// Types that represent real evidence of commercial intent — used both by
// the stale-conversation safety net (only fires when one of these exists)
// and by isHotLead (a task only counts as a "hot lead" when its type is in
// this set). "other" and "customer_unresponsive" are deliberately excluded:
// neither is proof of intent on its own.
export const OPPORTUNITY_SIGNAL_TASK_TYPES: Array<(typeof TASK_TYPES)[number]> = TASK_TYPES.filter(
  (type) => type !== "other" && type !== "customer_unresponsive"
);

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const TASK_PRIORITY_LABELS: Record<(typeof TASK_PRIORITIES)[number], string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};

export const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled", "rescheduled"] as const;

export const TASK_STATUS_LABELS: Record<(typeof TASK_STATUSES)[number], string> = {
  pending: "Pendente",
  in_progress: "Em andamento",
  completed: "Concluída",
  cancelled: "Cancelada",
  rescheduled: "Reagendada",
};

export const DEFAULT_TASK_RULES = {
  stale_conversation_hours: 24,
  think_it_over_days: 2,
};

// Used whenever agent.tools_config.followup_automatico is absent (every row
// written before this feature shipped) — see ToolsConfig, FollowupAutomaticoConfig.
export const DEFAULT_FOLLOWUP_AUTOMATICO = {
  ativo: false,
  primeiro_followup_horas: 1,
  segundo_followup_horas: 23,
  janela_inicio_hora: 8,
  janela_fim_hora: 18,
};

export const INSTANCE_STATUSES = ["connected", "disconnected", "connecting"] as const;

// Fallback used when an organization hasn't configured its own
// human_takeover_timeout_minutes (see OrganizationSettings) — orgs can set
// a different value, or disable auto-resume entirely, from Configurações.
export const DEFAULT_HUMAN_TAKEOVER_TIMEOUT_MINUTES = 30;
export const HUMAN_TAKEOVER_TIMEOUT_MS = DEFAULT_HUMAN_TAKEOVER_TIMEOUT_MINUTES * 60 * 1000;

// requestHuman-originated handoffs never auto-resume on the normal takeover
// timeout above — instead, if no human replies within this many minutes
// (business hours), a "handoff sem resposta" alert is raised in the panel.
// Orgs that haven't configured handoff_unanswered_alert_minutes fall back here.
export const DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES = 15;

// Fase 2, item 5 — used whenever an org hasn't configured its own
// libera_cred_resumption_window_days / libera_cred_table_max_age_days /
// libera_cred_resumption_daily_limit (see OrganizationSettings).
export const DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG = {
  window_days: 15,
  table_max_age_days: 30,
  daily_limit: 10,
  // Days stalled in plan_term_presented before each cadence step (item 5b).
  create_after_days: 2,
  escalate_after_days: 7,
};

export const HANDOFF_TRIGGER_TYPES = [
  "request_human",
  "painel_manual",
  "fromMe_real",
  "fromMe_greeting_filtered",
] as const;

export const HANDOFF_MOTIVOS = [
  "cliente_pediu",
  "negociacao_valor",
  "proposta_pronta",
  "documentos",
  "reclamacao",
  "fora_do_escopo",
  "ia_sem_resposta",
] as const;

export const HANDOFF_MOTIVO_LABELS: Record<(typeof HANDOFF_MOTIVOS)[number], string> = {
  cliente_pediu: "Cliente pediu atendimento humano",
  negociacao_valor: "Negociação de valor",
  proposta_pronta: "Proposta pronta",
  documentos: "Documentos",
  reclamacao: "Reclamação",
  fora_do_escopo: "Fora do escopo",
  ia_sem_resposta: "IA sem resposta",
};

export const HANDOFF_URGENCIAS = ["baixa", "normal", "alta"] as const;

export const EMBEDDING_DIMENSION = 1536;

export const DEFAULT_AGENT_SETTINGS = {
  temperature: 0.7,
  max_tokens: 1024,
  model: "gpt-4o-mini",
  provider: "openai" as const,
};

export const QUEUE_NAMES = {
  PROCESS_MESSAGE: "process-message",
  SEND_MESSAGE: "send-message",
  PROCESS_DOCUMENT: "process-document",
  TAKEOVER_TIMEOUT: "takeover-timeout",
  STALE_CONVERSATION_FOLLOWUP: "stale-conversation-followup",
} as const;

export const OPERATIONS = [
  "vehicle_sale",
  "consortium",
  "financing",
  "libera_cred",
  "contemplated_letter",
] as const;

export const OPERATION_LABELS: Record<(typeof OPERATIONS)[number], string> = {
  vehicle_sale: "Venda de veículos e elétricos",
  consortium: "Consórcio",
  financing: "Financiamento",
  libera_cred: "Libera Cred",
  contemplated_letter: "Carta contemplada",
};

export const FUNNEL_STAGES: Record<(typeof OPERATIONS)[number], readonly string[]> = {
  vehicle_sale: ["interest_received", "qualification", "proposal_sent", "negotiation", "formalization"],
  consortium: ["interest_received", "qualification", "simulation_sent", "decision_negotiation", "membership"],
  financing: [
    "interest_received",
    "qualification",
    "documentation",
    "bank_analysis",
    "conditions_approved_negotiation",
    "formalization",
  ],
  libera_cred: ["interest_received", "qualification", "plan_term_presented", "decision_objections", "membership"],
  contemplated_letter: [
    "interest_received",
    "qualification",
    "compatible_letter_search",
    "proposal_sent",
    "analysis_transfer",
  ],
};

export const FUNNEL_STAGE_LABELS: Record<string, string> = {
  interest_received: "Interesse recebido",
  qualification: "Qualificação",
  proposal_sent: "Proposta enviada",
  negotiation: "Negociação",
  formalization: "Formalização",
  simulation_sent: "Simulação enviada",
  decision_negotiation: "Decisão/negociação",
  membership: "Adesão",
  documentation: "Documentação",
  bank_analysis: "Análise bancária",
  conditions_approved_negotiation: "Condições aprovadas em negociação",
  plan_term_presented: "Plano e prazo apresentados",
  decision_objections: "Decisão/objeções",
  compatible_letter_search: "Busca de carta compatível",
  analysis_transfer: "Análise/transferência",
};

export const OPPORTUNITY_STATUSES = ["open", "won", "lost"] as const;

export const OPPORTUNITY_STATUS_LABELS: Record<(typeof OPPORTUNITY_STATUSES)[number], string> = {
  open: "Aberto",
  won: "Ganho",
  lost: "Perdido",
};

export const WAITING_ON_OPTIONS = ["customer", "team", "bank_or_admin", "scheduled_date"] as const;

export const WAITING_ON_LABELS: Record<(typeof WAITING_ON_OPTIONS)[number], string> = {
  customer: "Cliente",
  team: "Equipe",
  bank_or_admin: "Banco/administradora",
  scheduled_date: "Data combinada",
};

export const PRODUCTS = ["car", "motorcycle", "real_estate", "e_bike"] as const;

export const PRODUCT_LABELS: Record<(typeof PRODUCTS)[number], string> = {
  car: "Carro",
  motorcycle: "Moto",
  real_estate: "Imóvel",
  e_bike: "Bike elétrica",
};

export function isValidStage(operation: (typeof OPERATIONS)[number], stage: string): boolean {
  return (FUNNEL_STAGES[operation] as readonly string[]).includes(stage);
}
