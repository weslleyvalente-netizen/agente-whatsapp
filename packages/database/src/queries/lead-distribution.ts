// packages/database/src/queries/lead-distribution.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addBusinessMinutes, DEFAULT_LEAD_SLA_MINUTES, resolveBusinessCalendar,
  type DistributionContext, type LeadAssignment, type OrganizationSettings, type SalesRep, type SalesRepAvailability,
} from "@aula-agente/shared";
import { getOrganizationById } from "./organizations.js";

/** Prazo do SLA em minutos úteis. Nunca lança: calendário inválido cai no padrão. */
export function computeSlaDueAt(settings: Partial<OrganizationSettings>, from: Date): Date {
  const minutes = Number.isFinite(settings.lead_sla_minutes) && (settings.lead_sla_minutes as number) > 0 ? (settings.lead_sla_minutes as number) : DEFAULT_LEAD_SLA_MINUTES;
  const calendar = resolveBusinessCalendar(settings.business_calendar);
  try { return addBusinessMinutes(from, minutes, calendar); } catch { return addBusinessMinutes(from, minutes); }
}

export async function distributeLeadForHandoff(
  db: SupabaseClient,
  p: { organizationId: string; conversationId: string; handoffEventId: string; context?: DistributionContext; now?: Date }
): Promise<string | null> {
  const org = await getOrganizationById(db, p.organizationId);
  const live = org.settings.lead_distribution_enabled === true;
  if (!live && org.settings.lead_distribution_shadow_enabled !== true) return null;
  const due = computeSlaDueAt(org.settings, p.now ?? new Date());
  // Modo sombra decide e registra (lead_distribution_shadow_log) sem alterar nada real.
  const { data, error } = await db.rpc(live ? "distribute_lead" : "distribute_lead_shadow", {
    p_organization_id: p.organizationId, p_conversation_id: p.conversationId, p_handoff_event_id: p.handoffEventId,
    p_sla_due_at: due.toISOString(), p_context: p.context ?? {},
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** Usuário do vendedor da atribuição ativa (pendente/aceita) da conversa, ou null. */
export async function getActiveAssignmentRepUserId(db: SupabaseClient, organizationId: string, conversationId: string): Promise<string | null> {
  const { data, error } = await db.from("lead_assignments").select("rep_id, sales_reps(user_id)")
    .eq("organization_id", organizationId).eq("conversation_id", conversationId).in("status", ["pending", "accepted"]).maybeSingle();
  if (error) throw error;
  const rep = (data as { sales_reps?: { user_id?: string } | Array<{ user_id?: string }> | null } | null)?.sales_reps;
  return (Array.isArray(rep) ? rep[0]?.user_id : rep?.user_id) ?? null;
}

/** A conversa está na fila de exceções do gestor (exceção ainda não resolvida)? */
export async function hasOpenDistributionException(db: SupabaseClient, organizationId: string, conversationId: string): Promise<boolean> {
  const { data, error } = await db.from("lead_assignments").select("id")
    .eq("organization_id", organizationId).eq("conversation_id", conversationId).eq("status", "exception").is("resolved_at", null).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Registra a exceção distribution_error (idempotente por handoff; no-op com a flag desligada). */
export async function recordDistributionError(
  db: SupabaseClient,
  p: { organizationId: string; conversationId: string; handoffEventId: string; message: string }
): Promise<string | null> {
  const { data, error } = await db.rpc("record_distribution_error", {
    p_organization_id: p.organizationId, p_conversation_id: p.conversationId, p_handoff_event_id: p.handoffEventId, p_message: p.message,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function listExpiredAssignments(db: SupabaseClient, limit = 50) {
  const { data, error } = await db.from("lead_assignments").select("id, organization_id")
    .eq("status", "pending").eq("sla_action", "redistribute").lte("sla_due_at", new Date().toISOString()).order("sla_due_at").limit(limit);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; organization_id: string }>;
}

export async function flagSlaAlerts(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc("flag_sla_alerts");
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

export async function listSlaAlerts(db: SupabaseClient, organizationId: string): Promise<LeadAssignment[]> {
  const { data, error } = await db.from("lead_assignments").select("*").eq("organization_id", organizationId)
    .eq("status", "pending").eq("sla_action", "alert").eq("sla_breached", true).order("sla_due_at");
  if (error) throw error;
  return (data ?? []) as LeadAssignment[];
}

export async function redistributeAssignment(db: SupabaseClient, id: string, newSlaDueAt: Date): Promise<string | null> {
  const { data, error } = await db.rpc("redistribute_assignment", { p_assignment_id: id, p_new_sla_due_at: newSlaDueAt.toISOString() });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function acceptAssignment(db: SupabaseClient, p: { assignmentId: string; actorUserId: string; actorIsAdmin: boolean }): Promise<boolean> {
  const { data, error } = await db.rpc("accept_assignment", { p_assignment_id: p.assignmentId, p_actor: p.actorUserId, p_actor_is_admin: p.actorIsAdmin });
  if (error) throw error;
  return data === true;
}

export async function recordHumanMessage(
  db: SupabaseClient,
  p: { organizationId: string; conversationId: string; at: Date; authorUserId: string | null; via: "panel" | "phone_echo" }
): Promise<string | null> {
  const { data, error } = await db.rpc("record_human_message", {
    p_organization_id: p.organizationId, p_conversation_id: p.conversationId, p_at: p.at.toISOString(), p_author: p.authorUserId, p_via: p.via,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function manualAssignLead(
  db: SupabaseClient,
  p: { organizationId: string; conversationId: string; repId: string; actorUserId: string; slaDueAt: Date }
): Promise<string> {
  const { data, error } = await db.rpc("manual_assign", {
    p_organization_id: p.organizationId, p_conversation_id: p.conversationId, p_rep_id: p.repId, p_actor: p.actorUserId, p_sla_due_at: p.slaDueAt.toISOString(),
  });
  if (error) throw error;
  return data as string;
}

export async function listSalesReps(db: SupabaseClient, organizationId: string): Promise<SalesRep[]> {
  const { data, error } = await db.from("sales_reps").select("*").eq("organization_id", organizationId).order("rotation_order");
  if (error) throw error;
  return (data ?? []) as SalesRep[];
}

export async function getSalesRepByUser(db: SupabaseClient, organizationId: string, userId: string): Promise<SalesRep | null> {
  const { data, error } = await db.from("sales_reps").select("*").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as SalesRep | null) ?? null;
}

export async function setRepAvailability(db: SupabaseClient, p: { organizationId: string; repId: string; availability: SalesRepAvailability }): Promise<SalesRep> {
  const now = new Date().toISOString();
  const { data, error } = await db.from("sales_reps")
    .update({ availability: p.availability, availability_changed_at: now, updated_at: now })
    .eq("organization_id", p.organizationId).eq("id", p.repId).select("*").single();
  if (error) throw error;
  return data as SalesRep;
}

export async function listAssignmentsForContact(db: SupabaseClient, organizationId: string, contactId: string): Promise<LeadAssignment[]> {
  const { data, error } = await db.from("lead_assignments").select("*").eq("organization_id", organizationId).eq("contact_id", contactId).order("assigned_at");
  if (error) throw error;
  return (data ?? []) as LeadAssignment[];
}

export async function listOpenExceptions(db: SupabaseClient, organizationId: string): Promise<LeadAssignment[]> {
  const { data, error } = await db.from("lead_assignments").select("*").eq("organization_id", organizationId).eq("status", "exception").is("resolved_at", null).order("assigned_at");
  if (error) throw error;
  return (data ?? []) as LeadAssignment[];
}

export async function listActiveAssignments(db: SupabaseClient, organizationId: string): Promise<LeadAssignment[]> {
  const { data, error } = await db.from("lead_assignments").select("*").eq("organization_id", organizationId).in("status", ["pending", "accepted"]);
  if (error) throw error;
  return (data ?? []) as LeadAssignment[];
}
