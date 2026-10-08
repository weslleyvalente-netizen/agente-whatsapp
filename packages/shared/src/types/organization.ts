import type { TaskPriorityScoreWeights } from "../task-priority-score.js";

export type OrganizationPlan = "free" | "pro" | "enterprise";

export type MemberRole = "owner" | "admin" | "agent";

export type InvitationStatus = "pending" | "accepted" | "expired";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: OrganizationPlan;
  settings: OrganizationSettings;
  created_at: string;
  updated_at: string;
}

export interface OrganizationSettings {
  sales_workspace_enabled?: boolean;
  sales_action_queue_enabled?: boolean;
  sales_qualified_handoff_task_enabled?: boolean;
  sales_auto_pipeline_enabled?: boolean;
  sales_opportunity_freeze_enabled?: boolean;
  sales_low_intent_cadence_enabled?: boolean;
  sales_low_intent_cadence_started_at?: string;
  sales_low_intent_final_delay_hours?: number;
  sales_low_intent_closing_message?: string;
  scheduled_ad_closure_enabled?: boolean;
  // Cancela, uma vez por dia, tarefas automáticas de silêncio que não precisam de atendimento humano. Desligada por padrão.
  silence_task_auto_retire_enabled?: boolean;
  silence_task_auto_retire_days?: number;
  // Tamanho da lista "Hoje"; o restante fica na reserva. Padrão 15.
  today_list_limit?: number;
  scheduled_ad_closure_batch?: import('../ad-closure.js').ScheduledAdClosureBatch;
  // Distribuição de leads (rodízio). Desligada por padrão.
  lead_distribution_enabled?: boolean;
  lead_distribution_activated_at?: string;
  lead_sla_minutes?: number;
  owner_lookback_days?: number;
  business_calendar?: import("../business-calendar.js").BusinessCalendar;
  // Modo sombra da distribuição (registra o que faria, sem atribuir de fato).
  lead_distribution_shadow_enabled?: boolean;
  max_documents: number;
  max_agents: number;
  max_instances: number;
  // Minutes of human-takeover inactivity before the AI agent auto-resumes.
  // `null` disables auto-resume entirely — takeover then only ends when a
  // human explicitly hands the conversation back via "Devolver ao Agente".
  // `undefined` (orgs that haven't configured this yet) falls back to
  // DEFAULT_HUMAN_TAKEOVER_TIMEOUT_MINUTES.
  human_takeover_timeout_minutes?: number | null;
  // Minutes to wait for a human reply after a requestHuman-originated
  // handoff before raising a "handoff sem resposta" alert in the panel.
  // `undefined` falls back to DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES.
  handoff_unanswered_alert_minutes?: number;
  // user_id assigned to a conversation when requestHuman activates takeover
  // and no one is assigned yet. No hardcoded person — each org configures
  // its own default in Configurações. `null`/`undefined` means the handoff
  // still activates takeover but leaves assigned_to unset.
  default_handoff_assignee_id?: string | null;
  // Digits-only WhatsApp number (Evolution format) notified on every
  // requestHuman handoff. Optional — omitted/null disables the notification.
  handoff_notification_phone?: string | null;
  // See greeting-filter.ts (isGreetingOrShortConfirmation). Optional: orgs
  // that haven't configured this yet fall back to
  // DEFAULT_GREETING_FILTER_ENABLED / DEFAULT_GREETING_WORDS /
  // DEFAULT_GREETING_MAX_LENGTH.
  takeover_greeting_filter_enabled?: boolean;
  takeover_greeting_words?: string[];
  takeover_greeting_max_length?: number;
  // Fase 2 (triagem de tarefas) — todas `undefined`/`false` por padrão, sem
  // efeito até a organização ligar explicitamente em Configurações.
  // item 1(a): liga o vínculo automático de opportunity_id em tarefas novas.
  task_auto_link_opportunity_enabled?: boolean;
  // item 2: liga a consolidação por oportunidade (lista de pendências) em
  // vez da dedup por tipo de hoje.
  task_consolidation_by_opportunity_enabled?: boolean;
  // item 3: liga o encerramento automático de awaiting_customer_cpf/data.
  task_auto_close_awaiting_customer_enabled?: boolean;
  // item 4: override opcional dos pesos do score — ausente usa
  // DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS.
  task_priority_score_weights?: Partial<TaskPriorityScoreWeights>;
  // item 5: liga a checagem/criação de tarefas de retomada do LiberaCred.
  libera_cred_resumption_enabled?: boolean;
  // item 5(a): só considera oportunidades cujo contato interagiu nos
  // últimos N dias. Ausente usa DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.
  libera_cred_resumption_window_days?: number;
  // item 5(a): idade máxima (dias) da tabela de planos antes de ser
  // considerada desatualizada.
  libera_cred_table_max_age_days?: number;
  // item 5(c): máximo de tarefas de retomada NOVAS criadas por dia (não
  // conta escalonamentos de tarefas já existentes).
  libera_cred_resumption_daily_limit?: number;

  // Follow-up direto da tarefa — todas `undefined`/`false` por padrão,
  // mesmo padrão de rollout das fases anteriores.
  // Chave mestra: sem ela ligada, as rotas de sugestão/envio recusam.
  task_followup_enabled?: boolean;
  // Por padrão, enviar um follow-up NÃO ativa is_human_takeover (a Helena
  // continua respondendo normalmente). A organização pode ligar para exigir
  // handoff humano depois de qualquer follow-up manual.
  task_followup_takeover_on_send?: boolean;
  // Anti-ban: contados por evolution_instance_id, não por organização — ver
  // task-followup-throttle.ts. Ausente usa DEFAULT_TASK_FOLLOWUP_CONFIG.
  task_followup_min_interval_seconds?: number;
  task_followup_daily_limit?: number;
  // Limite de vezes que "Gerar outra" pode ser usado numa mesma tarefa.
  task_followup_max_regenerations?: number;
  // Coordenação com a cadência automática de 1h/23h (Helena) — ver
  // packages/shared/src/task-followup-coordination.ts. Ausente usa
  // DEFAULT_TASK_FOLLOWUP_CONFIG.
  task_followup_min_hours_since_last_touch?: number;
  task_followup_max_touches_without_reply?: number;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInvitation {
  id: string;
  organization_id: string;
  email: string;
  role: Exclude<MemberRole, "owner">;
  invited_by: string;
  status: InvitationStatus;
  expires_at: string;
  created_at: string;
}

export type IgnoredContactRetentionMode = "no_store" | "minimal_record";

export interface OrganizationIgnoredContact {
  id: string;
  organization_id: string;
  phone: string;
  label: string | null;
  retention_mode: IgnoredContactRetentionMode;
  created_by: string | null;
  created_at: string;
}

export interface OrganizationSecret {
  id: string;
  organization_id: string;
  provider: LLMProvider;
  encrypted_key: string;
  created_at: string;
  updated_at: string;
}

export type LLMProvider = "openai" | "anthropic" | "google";
