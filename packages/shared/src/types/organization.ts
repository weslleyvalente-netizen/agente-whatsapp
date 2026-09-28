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
