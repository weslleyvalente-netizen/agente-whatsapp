export const SALES_REP_AVAILABILITIES = ["available", "paused", "out"] as const;
export type SalesRepAvailability = (typeof SALES_REP_AVAILABILITIES)[number];

export const LEAD_ASSIGNMENT_STATUSES = ["pending", "accepted", "expired", "redistributed", "exception"] as const;
export type LeadAssignmentStatus = (typeof LEAD_ASSIGNMENT_STATUSES)[number];

export const LEAD_ASSIGNMENT_REASONS = ["round_robin", "existing_owner", "sla_redistribution", "manual", "bulk_reassignment", "exception"] as const;
export type LeadAssignmentReason = (typeof LEAD_ASSIGNMENT_REASONS)[number];

export const LEAD_EXCEPTION_REASONS = ["no_available_rep", "all_reps_sla_breached", "invalid_existing_owner", "distribution_error", "manual_review"] as const;
export type LeadExceptionReason = (typeof LEAD_EXCEPTION_REASONS)[number];

export const LEAD_ACCEPTED_VIA = ["button", "first_message", "phone_echo", "admin"] as const;
export type LeadAcceptedVia = (typeof LEAD_ACCEPTED_VIA)[number];

export const DEFAULT_LEAD_SLA_MINUTES = 15;
export const DEFAULT_OWNER_LOOKBACK_DAYS = 30;
export const DISTRIBUTION_STRATEGY_VERSION = "round_robin_v1";

export interface SalesRep {
  id: string;
  organization_id: string;
  user_id: string;
  display_name: string;
  availability: SalesRepAvailability;
  availability_changed_at: string;
  rotation_order: number;
  last_assigned_at: string | null;
  // Reservados para o futuro: existem no banco, mas a estratégia atual os ignora.
  weight: number | null;
  max_active_leads: number | null;
  specialties: string[];
  score: number | null;
}

export interface LeadAssignment {
  id: string;
  organization_id: string;
  chain_id: string;
  handoff_event_id: string;
  contact_id: string;
  conversation_id: string;
  opportunity_id: string | null;
  rep_id: string | null;
  reason: LeadAssignmentReason;
  status: LeadAssignmentStatus;
  assigned_at: string;
  handoff_at: string;
  sla_due_at: string | null;
  sla_breached: boolean;
  redistribution_reason: string | null;
  accepted_at: string | null;
  accepted_via: LeadAcceptedVia | null;
  first_human_message_at: string | null;
  first_human_message_by: string | null;
  previous_assignment_id: string | null;
  next_assignment_id: string | null;
  exception_reason: LeadExceptionReason | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  origin_source: string | null;
  operation: string | null;
  product_model: string | null;
  strategy_version: string;
  created_at: string;
}

export interface DistributionContext {
  origin_source?: string | null;
  operation?: string | null;
  product_model?: string | null;
}

export interface PickRepInput {
  reps: Array<Pick<SalesRep, "id" | "availability" | "rotation_order">>;
  lastRotationOrder: number;
  excludeRepIds?: string[];
  /** Hoje ignorado; a estratégia futura (peso, especialidade, origem) lê daqui. */
  context?: DistributionContext;
}

/** Estratégia atual: o próximo vendedor `available` depois do ponteiro, voltando ao início. Espelha o SQL de `distribute_lead`. */
export function pickRep(input: PickRepInput): string | null {
  const excluded = new Set(input.excludeRepIds ?? []);
  const eligible = input.reps
    .filter(r => r.availability === "available" && !excluded.has(r.id))
    .sort((a, b) => a.rotation_order - b.rotation_order);
  if (!eligible.length) return null;
  return (eligible.find(r => r.rotation_order > input.lastRotationOrder) ?? eligible[0]).id;
}

export interface HumanOriginInput {
  role: string;
  source: "panel" | "phone_echo";
  actorUserId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** O eco corresponde a uma mensagem que o próprio sistema enviou (mesmo evolution_message_id). */
  echoMatchedSystemMessage?: boolean;
  /** Saudação curta ("Bom dia") filtrada pelo webhook: não assume atendimento. */
  greetingFiltered?: boolean;
}

// Marcadores gravados em messages.metadata por envios automáticos. Todo remetente automático novo deve usar role "agent" ou um destes.
const AUTOMATION_METADATA_KEYS = ["scheduled_ad_closure", "low_intent_followup", "system_generated"];

/** Só mensagem de origem humana comprovada assume lead ou conta como "primeira resposta humana". */
export function isHumanOriginMessage(i: HumanOriginInput): boolean {
  if (i.role !== "human_agent") return false;
  if (i.echoMatchedSystemMessage) return false;
  const metadata = i.metadata ?? {};
  if (AUTOMATION_METADATA_KEYS.some(key => key in metadata)) return false;
  if (i.source === "panel") return !!i.actorUserId;
  return !i.greetingFiltered;
}
