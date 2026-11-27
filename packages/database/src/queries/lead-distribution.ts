// packages/database/src/queries/lead-distribution.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addBusinessMinutes, DEFAULT_LEAD_SLA_MINUTES, resolveBusinessCalendar,
  type DistributionContext, type LeadAssignment, type OrganizationSettings, type SalesRep, type SalesRepAvailability,
} from "@aula-agente/shared";
import { getOrganizationById } from "./organizations.js";
import { fetchAllPages } from "../pagination.js";

/** Prazo do SLA em minutos úteis. Nunca lança: calendário inválido cai no padrão. */
export function computeSlaDueAt(settings: Partial<OrganizationSettings>, from: Date): Date {
  const minutes = Number.isFinite(settings.lead_sla_minutes) && (settings.lead_sla_minutes as number) > 0 ? (settings.lead_sla_minutes as number) : DEFAULT_LEAD_SLA_MINUTES;
  const calendar = resolveBusinessCalendar(settings.business_calendar);
  try { return addBusinessMinutes(from, minutes, calendar); } catch { return addBusinessMinutes(from, minutes); }
}

/** Prazo do estágio 2 da escalada: 2x o SLA da organização a partir do momento da atribuição, no mesmo calendário comercial. */
export function computeEscalationDueAt(settings: Partial<OrganizationSettings>, assignedAt: Date): Date {
  const minutes = Number.isFinite(settings.lead_sla_minutes) && (settings.lead_sla_minutes as number) > 0 ? (settings.lead_sla_minutes as number) : DEFAULT_LEAD_SLA_MINUTES;
  const calendar = resolveBusinessCalendar(settings.business_calendar);
  try { return addBusinessMinutes(assignedAt, minutes * 2, calendar); } catch { return addBusinessMinutes(assignedAt, minutes * 2); }
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

/**
 * Cliente que escapou (escreveu e ninguém respondeu, nem a IA): encaminhamento + rodízio + atendimento humano numa ÚNICA transação
 * (função distribute_escaped_lead, migração 20261122120000). A IA só é desligada quando o rodízio entregou a um vendedor; rodízio
 * vazio desfaz tudo (devolve null); erro do rodízio lança e nada fica gravado. Só a distribuição real (sem modo sombra).
 */
export async function distributeEscapedLead(db: SupabaseClient, organizationId: string, conversationId: string, now: Date = new Date()): Promise<string | null> {
  const org = await getOrganizationById(db, organizationId);
  if (org.settings.lead_distribution_enabled !== true) return null;
  const { data, error } = await db.rpc("distribute_escaped_lead", {
    p_organization_id: organizationId, p_conversation_id: conversationId, p_sla_due_at: computeSlaDueAt(org.settings, now).toISOString(),
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
  // Pendente OU assumida e ainda aguardando a 1ª resposta (o banco, em redistribute_assignment, decide se já houve resposta confirmada).
  const { data, error } = await db.from("lead_assignments").select("id, organization_id")
    .or("status.eq.pending,and(status.eq.accepted,awaiting_first_response.eq.true)").eq("sla_action", "redistribute").lte("sla_due_at", new Date().toISOString()).order("sla_due_at").limit(limit);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; organization_id: string }>;
}

/**
 * Candidatas ao estágio 2 da escalada, já filtradas no banco (chave, janela de ativação/24 h, não respondida, cadeia não escalada),
 * em ordem de vencimento e com limite POR organização. Quem decide de fato é escalate_alert_assignment.
 */
export async function listEscalationCandidates(db: SupabaseClient, perOrg = 50) {
  const { data, error } = await db.rpc("list_escalation_candidates", { p_per_org: perOrg });
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; organization_id: string; assigned_at: string }>;
}

/** Repara cards de encaminhamento pulados (contato travado na hora): atribuições pendentes < 24 h sem negócio. Devolve quantos nasceram. */
export async function ensureHandoffCards(db: SupabaseClient, limit = 50): Promise<number> {
  const { data, error } = await db.rpc("ensure_handoff_cards", { p_limit: limit });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/** Estágio 2: passa o lead ao próximo vendedor elegível (uma vez por cadeia). Devolve a nova atribuição ou null se não agiu. */
export async function escalateAlertAssignment(db: SupabaseClient, id: string, escalateAt: Date, newSlaDueAt: Date): Promise<string | null> {
  const { data, error } = await db.rpc("escalate_alert_assignment", {
    p_assignment_id: id, p_escalate_at: escalateAt.toISOString(), p_new_sla_due_at: newSlaDueAt.toISOString(),
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** Fase C: fecha exceções já atendidas (resposta humana confirmada após o pedido, sem mensagem nova do cliente). Só age nas organizações
 *  com settings.exception_auto_resolve_enabled; devolve quantas fechou. */
export async function resolveAnsweredExceptions(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc("resolve_answered_exceptions");
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

export async function flagSlaAlerts(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc("flag_sla_alerts");
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

export interface HumanMessageRow { conversation_id: string; created_at: string; evolution_message_id?: string | null; metadata?: { send_failed_at?: string | null; sent_by_user_id?: string | null } | null }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Autor registrado pelo painel (metadata.sent_by_user_id); null = DESCONHECIDO (celular da loja, registro antigo ou chave inválida). Espelha public._msg_author. */
export const messageAuthor = (m: HumanMessageRow): string | null => { const v = m.metadata?.sent_by_user_id; return typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null; };
/** A mensagem conta para o vendedor? Autor dele OU desconhecido. Autor conhecido diferente (ex.: o gestor) não conta. */
export const countsForRep = (m: HumanMessageRow, repUserId: string | null | undefined): boolean => { const au = messageAuthor(m); return au === null || !repUserId || au === repUserId.toLowerCase(); };
/** Janela de envio: uma mensagem em voo adia a decisão por no máximo isto; depois, sem id, conta como NÃO ENVIADA. Espelha as funções SQL _human_msg_*. */
export const SEND_WINDOW_MS = 10 * 60_000;
const sendFailed = (m: HumanMessageRow) => Boolean(m.metadata?.send_failed_at);
/** Mensagem humana CONFIRMADA (id do WhatsApp) e sem falha, ou EM VOO (sem id, sem falha, dentro da janela de envio). */
export const isConfirmedOrInFlight = (m: HumanMessageRow, now: number): boolean =>
  !sendFailed(m) && (Boolean(m.evolution_message_id) || now - new Date(m.created_at).getTime() < SEND_WINDOW_MS);
/** NÃO ENVIADA: sem id e (falhou OU presa além da janela de envio). */
const isUnsent = (m: HumanMessageRow, now: number): boolean =>
  !m.evolution_message_id && (sendFailed(m) || now - new Date(m.created_at).getTime() >= SEND_WINDOW_MS);
/** Só houve envio não enviado (nenhum confirmado nem em voo)? E quando foi criada a última dessas mensagens. */
export function humanSendState(msgs: HumanMessageRow[], now: number): { failedOnly: boolean; lastFailedAt: number } {
  const unsent = msgs.filter((m) => isUnsent(m, now));
  const ok = msgs.some((m) => isConfirmedOrInFlight(m, now));
  return { failedOnly: unsent.length > 0 && !ok, lastFailedAt: unsent.reduce((x, m) => Math.max(x, new Date(m.created_at).getTime()), 0) };
}

/**
 * Atribuições 'alert' pendentes com SLA estourado e AINDA sem resposta. Mesma regra de public._alert_assignment_answered
 * (20261027120200_sla_alert_escalation.sql), reimplementada em lote porque a função SQL recebe a linha inteira
 * (lead_assignments) e não dá para chamá-la por RPC. Resposta dada pelo celular não marca first_human_message_at, então
 * a mensagem role='human_agent' na conversa também conta. Cobre: first_human_message_at/accepted_at, mensagem humana desde o
 * handoff (desde a atribuição nas manuais), ligação registrada, atividade comercial do negócio aberto, nota na conversa,
 * conversa fora de open/waiting e negócio ganho/perdido. FICA DE FORA (só a função SQL vê): task_events e opportunity_events
 * de autoria humana; nesses casos o alerta permanece no painel até a escalada/ação do gestor.
 */
export async function listSlaAlerts(db: SupabaseClient, organizationId: string): Promise<LeadAssignment[]> {
  const rows = await fetchAllPages<LeadAssignment>(async (from, to) => {
    const { data, error } = await db.from("lead_assignments").select("*").eq("organization_id", organizationId)
      .or("status.eq.pending,and(status.eq.accepted,awaiting_first_response.eq.true)").eq("sla_action", "alert").eq("sla_breached", true).order("sla_due_at").order("id").range(from, to);
    if (error) throw error;
    return (data ?? []) as LeadAssignment[];
  });
  if (!rows.length) return rows;

  const conversationIds = [...new Set(rows.map((r) => r.conversation_id))];
  const contactIds = [...new Set(rows.map((r) => r.contact_id))];
  const t = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
  const sinceOf = (r: LeadAssignment) => t(r.reason === "manual" ? r.assigned_at : r.handoff_at);
  const minHandoff = Math.min(...rows.map((r) => Math.min(sinceOf(r), t(r.assigned_at), t(r.handoff_at))));
  const minIso = new Date(minHandoff).toISOString();

  // Ids em lotes de 100 (limite de URL do PostgREST) e cada lote paginado (teto de 1000 linhas por resposta). Sem janela de data:
  // alertas antigos sem resposta continuam visíveis.
  const chunks = <T>(ids: T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < ids.length; i += 100) out.push(ids.slice(i, i + 100)); return out; };
  const fetchIn = async <T>(ids: string[], build: (batch: string[]) => any, order: string): Promise<T[]> => {
    const all: T[] = [];
    for (const batch of chunks(ids)) {
      all.push(...await fetchAllPages<T>(async (from, to) => {
        const { data: page, error: e } = await build(batch).order(order).order("id").range(from, to);
        if (e) throw e;
        return (page ?? []) as T[];
      }));
    }
    return all;
  };
  const [messageRows, conversationRows, noteRows, oppRows, repRows] = await Promise.all([
    fetchIn<HumanMessageRow>(conversationIds, (ids) =>
      db.from("messages").select("id, conversation_id, created_at, evolution_message_id, metadata").eq("organization_id", organizationId).eq("role", "human_agent").in("conversation_id", ids).gte("created_at", minIso), "created_at"),
    fetchIn<{ id: string; status: string }>(conversationIds, (ids) => db.from("conversations").select("id, status").in("id", ids), "id"),
    fetchIn<{ conversation_id: string; created_at: string }>(conversationIds, (ids) =>
      db.from("conversation_notes").select("id, conversation_id, created_at").in("conversation_id", ids).gte("created_at", minIso), "created_at"),
    fetchIn<{ id: string; contact_id: string; status: string; last_commercial_activity_at: string | null; updated_at: string | null }>(contactIds, (ids) =>
      db.from("opportunities").select("id, contact_id, status, last_commercial_activity_at, updated_at").eq("organization_id", organizationId).in("contact_id", ids), "id"),
    fetchIn<{ id: string; user_id: string | null }>([...new Set(rows.map((r) => r.rep_id).filter((x): x is string => Boolean(x)))], (ids) =>
      db.from("sales_reps").select("id, user_id").eq("organization_id", organizationId).in("id", ids), "id"),
  ]);
  const repUserById = new Map(repRows.map((r) => [r.id, r.user_id]));
  const oppIds = oppRows.map((o) => o.id);
  type CallRow = { contact_id: string | null; opportunity_id: string | null; called_at: string };
  const callBase = (db2: SupabaseClient) => db2.from("sales_call_logs").select("id, contact_id, opportunity_id, called_at").eq("organization_id", organizationId).gte("called_at", minIso);
  const [callsByContact, callsByOpp] = await Promise.all([
    fetchIn<CallRow>(contactIds, (ids) => callBase(db).in("contact_id", ids), "called_at"),
    fetchIn<CallRow>(oppIds, (ids) => callBase(db).in("opportunity_id", ids), "called_at"),
  ]);

  const group = <T extends Record<string, any>>(list: T[] | null, key: string) => {
    const m = new Map<string, T[]>();
    for (const x of list ?? []) m.set(x[key], [...(m.get(x[key]) ?? []), x]);
    return m;
  };
  const humanByConv = group(messageRows, "conversation_id");
  const notesByConv = group(noteRows, "conversation_id");
  const oppsByContact = group(oppRows, "contact_id");
  const statusByConv = new Map(conversationRows.map((c) => [c.id, c.status]));
  const callList = [...callsByContact, ...callsByOpp];

  const answered = (a: LeadAssignment): boolean => {
    const ru = (a.rep_id ? repUserById.get(a.rep_id) : null) ?? null;
    const all = (humanByConv.get(a.conversation_id) ?? []).filter((m) => t(m.created_at) >= t(a.assigned_at));
    const mine = all.filter((m) => countsForRep(m, ru)); // só mensagem do vendedor ou de autoria desconhecida
    const state = humanSendState(mine, Date.now());
    // Marco de 1ª mensagem: o autor registrado precisa ser o vendedor (nulo = celular/antigo, vale). Aceite por mensagem vale. O botão Assumir, sozinho, nunca vale.
    const markerOk = Boolean(a.first_human_message_at) && (!a.first_human_message_by || a.first_human_message_by === ru);
    if ((markerOk || a.accepted_via === "first_message" || a.accepted_via === "phone_echo") && !state.failedOnly) return true;
    if ((humanByConv.get(a.conversation_id) ?? []).some((m) => t(m.created_at) >= sinceOf(a) && countsForRep(m, ru) && isConfirmedOrInFlight(m, Date.now()))) return true;
    const opps = oppsByContact.get(a.contact_id) ?? [];
    const oppSet = new Set(opps.map((o) => o.id));
    if (callList.some((l) => t(l.called_at) >= t(a.assigned_at) && (l.contact_id === a.contact_id || (l.opportunity_id && oppSet.has(l.opportunity_id))))) return true;
    // last_commercial_activity_at é gravado quando o envio é pedido: se só houve envio não enviado, vale só o que vier depois da janela de envio (+10 min).
    let oppSince = state.failedOnly ? Math.max(t(a.assigned_at), state.lastFailedAt + SEND_WINDOW_MS) : t(a.assigned_at);
    // Também gravada quando OUTRO autor (ex.: o gestor) pede um envio: sem nenhuma mensagem do vendedor/desconhecida, ignora a janela de envio dessa mensagem alheia.
    const otherAt = Math.max(0, ...all.filter((m) => !countsForRep(m, ru)).map((m) => t(m.created_at)), a.first_human_message_by && a.first_human_message_by !== ru ? t(a.first_human_message_at) : 0);
    if (otherAt > 0 && mine.length === 0) oppSince = Math.max(oppSince, otherAt + SEND_WINDOW_MS);
    if (opps.some((o) => o.status === "open" && t(o.last_commercial_activity_at) >= oppSince)) return true;
    if ((notesByConv.get(a.conversation_id) ?? []).some((n) => t(n.created_at) >= t(a.assigned_at))) return true;
    const status = statusByConv.get(a.conversation_id);
    if (status && status !== "open" && status !== "waiting") return true;
    return opps.some((o) => (o.status === "won" || o.status === "lost") && t(o.updated_at) >= t(a.handoff_at));
  };
  return rows.filter((a) => !answered(a));
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

export interface ContactBasics { id: string; name: string | null; phone: string | null }

/** Nome e telefone de vários contatos em lotes de 100 (sem N+1; limite de URL do PostgREST). Contato inexistente simplesmente não volta. */
export async function listContactsByIds(db: SupabaseClient, organizationId: string, ids: string[]): Promise<ContactBasics[]> {
  const unique = [...new Set(ids)];
  const out: ContactBasics[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await db.from("wa_contacts").select("id, name, phone").eq("organization_id", organizationId).in("id", unique.slice(i, i + 100));
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; name: string | null; phone: string | null }>) out.push({ id: r.id, name: r.name ?? null, phone: r.phone ?? null });
  }
  return out;
}

export interface NudgeTarget {
  id: string; conversation_id: string; contact_id: string; rep_id: string | null;
  status: string; sla_action: string; sla_breached: boolean; sla_due_at: string | null; assigned_at: string; awaiting_first_response?: boolean;
}

/** Atribuição da organização para o "Cutucar" (null se não existir nesta organização). */
export async function getAssignmentForNudge(db: SupabaseClient, organizationId: string, assignmentId: string): Promise<NudgeTarget | null> {
  const { data, error } = await db.from("lead_assignments")
    .select("id, conversation_id, contact_id, rep_id, status, sla_action, sla_breached, sla_due_at, assigned_at, awaiting_first_response")
    .eq("organization_id", organizationId).eq("id", assignmentId).maybeSingle();
  if (error) throw error;
  return (data as NudgeTarget | null) ?? null;
}

/** Instante do último toque registrado com esta chave (prefixo em push_notification_log: `nudge:<atribuição>:` ou `nudge-rep:<vendedor>:`). */
export async function getLastNudgeAt(db: SupabaseClient, keyPrefix: string): Promise<Date | null> {
  const { data, error } = await db.from("push_notification_log").select("created_at").like("dedupe_key", `${keyPrefix}%`)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? new Date((data as { created_at: string }).created_at) : null;
}

/** Registra um toque enviado (a chave leva o instante, então cada toque é uma linha; o worker apaga o log após 7 dias). */
export async function recordNudge(db: SupabaseClient, keyPrefix: string, userId: string, at: Date): Promise<void> {
  const { error } = await db.from("push_notification_log").insert({ dedupe_key: `${keyPrefix}${at.getTime()}`, user_id: userId, created_at: at.toISOString() });
  if (error) throw error;
}
