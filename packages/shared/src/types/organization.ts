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

export interface OrganizationSecret {
  id: string;
  organization_id: string;
  provider: LLMProvider;
  encrypted_key: string;
  created_at: string;
  updated_at: string;
}

export type LLMProvider = "openai" | "anthropic" | "google";
