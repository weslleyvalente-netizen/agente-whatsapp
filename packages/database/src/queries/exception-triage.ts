// P0a: leitura para a triagem de exceções, livro de alertas e eventos auditáveis (reconhecer/resolver).
// NADA aqui escreve em lead_assignments, lead_distribution_state, conversas, negócios ou tarefas: só lê esses fatos e grava nas
// tabelas novas (exception_events, exception_alert_ledger), que só a service role acessa.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyTriage, isResolutionEvent, type BusinessCalendar, type ExceptionAlertStage, type ExceptionEventKind, type LeadAssignment, type TriageKind, type TriageResult,
} from "@aula-agente/shared";
import { listContactsByIds } from "./lead-distribution.js";

export interface ExceptionEventRow { id: string; assignment_id: string; kind: ExceptionEventKind; actor_user_id: string; rep_id: string | null; note: string | null; created_at: string }

export interface TriageItem {
  assignment: LeadAssignment;
  kind: TriageKind;
  contact: { name: string | null; phone: string | null } | null;
  /** Vendedores que já passaram pela cadeia (ex.: Márcio, Marina), só nomes de exibição. */
  chainReps: string[];
  conversation: { id: string; status: string | null; assigned_to: string | null } | null;
  events: ExceptionEventRow[];
  triage: TriageResult;
}

const chunk = <T>(arr: T[], n = 100): T[][] => { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

async function selectIn<T>(db: SupabaseClient, table: string, columns: string, column: string, ids: string[], extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(ids)])) {
    let q: any = db.from(table).select(columns).in(column, part);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/**
 * Exceções abertas + atribuições `alert` pendentes e vencidas, já classificadas. Só leitura.
 * Âncora do atraso: exceção = primeiro handoff da cadeia (handoff_at, nunca reiniciado); alerta = data da atribuição.
 */
export async function loadTriageItems(db: SupabaseClient, organizationId: string, calendar: BusinessCalendar, now: Date = new Date()): Promise<TriageItem[]> {
  const [ex, al] = await Promise.all([
    db.from("lead_assignments").select("*").eq("organization_id", organizationId).eq("status", "exception").is("resolved_at", null).order("assigned_at"),
    db.from("lead_assignments").select("*").eq("organization_id", organizationId).eq("status", "pending").eq("sla_action", "alert").eq("sla_breached", true).order("sla_due_at"),
  ]);
  if (ex.error) throw ex.error;
  if (al.error) throw al.error;
  const rows = [
    ...((ex.data ?? []) as LeadAssignment[]).map(a => ({ a, kind: "exception" as const })),
    ...((al.data ?? []) as LeadAssignment[]).map(a => ({ a, kind: "alert" as const })),
  ];
  if (!rows.length) return [];

  const conversationIds = [...new Set(rows.map(r => r.a.conversation_id))];
  const contactIds = [...new Set(rows.map(r => r.a.contact_id))];
  const exceptionIds = rows.filter(r => r.kind === "exception").map(r => r.a.id);
  const chainIds = [...new Set(rows.map(r => r.a.chain_id))];
  const earliest = rows.map(r => (r.kind === "exception" ? r.a.handoff_at : r.a.assigned_at)).sort()[0];

  const [events, conversations, replies, openOpps, contacts, chain, reps, lastMessages] = await Promise.all([
    selectIn<ExceptionEventRow>(db, "exception_events", "id, assignment_id, kind, actor_user_id, rep_id, note, created_at", "assignment_id", exceptionIds),
    selectIn<{ id: string; status: string | null; assigned_to: string | null }>(db, "conversations", "id, status, assigned_to", "id", conversationIds),
    selectIn<{ conversation_id: string; content: string | null; created_at: string }>(db, "messages", "conversation_id, content, created_at", "conversation_id", conversationIds,
      q => q.eq("role", "human_agent").gte("created_at", earliest).order("created_at")),
    selectIn<{ contact_id: string }>(db, "opportunities", "contact_id", "contact_id", contactIds, q => q.eq("organization_id", organizationId).eq("status", "open")),
    listContactsByIds(db, organizationId, contactIds),
    selectIn<{ chain_id: string; rep_id: string | null }>(db, "lead_assignments", "chain_id, rep_id", "chain_id", chainIds, q => q.eq("organization_id", organizationId)),
    db.from("sales_reps").select("id, display_name").eq("organization_id", organizationId).then(r => { if (r.error) throw r.error; return (r.data ?? []) as Array<{ id: string; display_name: string }>; }),
    Promise.all(conversationIds.map(async id => {
      const { data, error } = await db.from("messages").select("role, created_at, content").eq("conversation_id", id).order("created_at", { ascending: false }).limit(1);
      if (error) throw error;
      return [id, ((data ?? [])[0] as { role: string; created_at: string; content: string | null } | undefined) ?? null] as const;
    })),
  ]);

  const convById = new Map(conversations.map(c => [c.id, c]));
  const contactById = new Map(contacts.map(c => [c.id, c]));
  const repName = new Map(reps.map(r => [r.id, r.display_name]));
  const lastByConv = new Map(lastMessages);
  const openContacts = new Set(openOpps.map(o => o.contact_id));
  const eventsByAssignment = new Map<string, ExceptionEventRow[]>();
  for (const e of events) eventsByAssignment.set(e.assignment_id, [...(eventsByAssignment.get(e.assignment_id) ?? []), e]);
  const repsByChain = new Map<string, string[]>();
  for (const c of chain) if (c.rep_id && repName.has(c.rep_id)) {
    const list = repsByChain.get(c.chain_id) ?? [];
    if (!list.includes(repName.get(c.rep_id)!)) list.push(repName.get(c.rep_id)!);
    repsByChain.set(c.chain_id, list);
  }

  return rows.map(({ a, kind }) => {
    const anchorAt = kind === "exception" ? a.handoff_at : a.assigned_at;
    const evs = (eventsByAssignment.get(a.id) ?? []).sort((x, y) => x.created_at.localeCompare(y.created_at));
    const resolution = evs.find(e => isResolutionEvent(e.kind)) ?? null;
    const last = lastByConv.get(a.conversation_id) ?? null;
    const conv = convById.get(a.conversation_id) ?? null;
    const triage = classifyTriage({
      kind, anchorAt, flaggedAt: kind === "exception" ? a.assigned_at : (a.sla_due_at ?? a.assigned_at),
      humanReplies: replies.filter(r => r.conversation_id === a.conversation_id && r.created_at >= anchorAt).map(r => ({ content: r.content, at: r.created_at })),
      lastMessage: last ? { role: last.role, at: last.created_at, content: last.content } : null,
      resolvedEvent: resolution ? { kind: resolution.kind, at: resolution.created_at } : null,
      conversationStatus: conv?.status ?? null, hasOpenOpportunity: openContacts.has(a.contact_id), now, calendar,
    });
    const contact = contactById.get(a.contact_id);
    return {
      assignment: a, kind, contact: contact ? { name: contact.name, phone: contact.phone } : null,
      chainReps: repsByChain.get(a.chain_id) ?? [], conversation: conv, events: evs, triage,
    };
  });
}

/** Reconhece ou resolve (função SQL atômica, idempotente, só service role). Lança com a mensagem do banco se a regra recusar. */
export async function recordExceptionEvent(
  db: SupabaseClient,
  input: { organizationId: string; assignmentId: string; kind: ExceptionEventKind; actorUserId: string; note?: string | null; repId?: string | null },
): Promise<string> {
  const { data, error } = await db.rpc("record_exception_event", {
    p_organization_id: input.organizationId, p_assignment_id: input.assignmentId, p_kind: input.kind, p_actor: input.actorUserId,
    p_note: input.note ?? null, p_rep_id: input.repId ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

// ---------- Livro de alertas ----------

export interface AlertLedgerClaim {
  organizationId: string; assignmentId: string; stage: ExceptionAlertStage; channel: "push" | "email" | "shadow" | "skipped";
  recipientUserId: string | null; mode: "shadow" | "on"; detail?: Record<string, unknown>;
}

export interface RecordedAlertSlot { stage: number; channel: string; recipientUserId: string | null; status: string }

/**
 * Linhas do livro por exceção, com destinatário e canal. O worker decide por DESTINATÁRIO o que já foi registrado
 * (quem não recebeu continua elegível) e por modo (linhas "shadow" não contam quando o modo é "on").
 */
export async function listRecordedAlertSlots(db: SupabaseClient, assignmentIds: string[]): Promise<Map<string, RecordedAlertSlot[]>> {
  const rows = await selectIn<{ assignment_id: string; stage: number; channel: string; recipient_user_id: string | null; status: string }>(
    db, "exception_alert_ledger", "assignment_id, stage, channel, recipient_user_id, status", "assignment_id", assignmentIds,
  );
  const out = new Map<string, RecordedAlertSlot[]>();
  for (const r of rows) {
    const list = out.get(r.assignment_id) ?? [];
    list.push({ stage: r.stage, channel: r.channel, recipientUserId: r.recipient_user_id, status: r.status });
    out.set(r.assignment_id, list);
  }
  return out;
}

/** Reserva o slot (exceção, estágio, canal, destinatário). INSERT atômico: o índice único decide; devolve null se outro processo já reservou. */
export async function claimAlertSlot(db: SupabaseClient, c: AlertLedgerClaim): Promise<{ id: number } | null> {
  const { data, error } = await db.from("exception_alert_ledger").insert({
    organization_id: c.organizationId, assignment_id: c.assignmentId, stage: c.stage, channel: c.channel, recipient_user_id: c.recipientUserId,
    mode: c.mode, status: c.channel === "skipped" ? "skipped" : "claimed", detail: c.detail ?? {},
  }).select("id");
  if (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
  const row = ((data ?? []) as Array<{ id: number }>)[0];
  return row ? { id: row.id } : null;
}

export async function finishAlertSlot(db: SupabaseClient, id: number, status: "sent" | "skipped", detail?: Record<string, unknown>): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === "sent") patch.sent_at = new Date().toISOString();
  if (detail) patch.detail = detail;
  const { error } = await db.from("exception_alert_ledger").update(patch).eq("id", id);
  if (error) throw error;
}

/**
 * Marca "vou chamar o push agora" ANTES do envio. Devolve false se a reserva não está mais 'claimed' ou já foi marcada
 * (então NÃO se envia). Depois desta marca, uma reserva sem confirmação nunca é reenviada (ver releaseStaleAlertClaims).
 */
export async function markAlertSending(db: SupabaseClient, id: number, now: Date = new Date()): Promise<boolean> {
  const { data, error } = await db.from("exception_alert_ledger").update({ send_started_at: now.toISOString() })
    .eq("id", id).eq("status", "claimed").is("send_started_at", null).select("id");
  if (error) throw error;
  return (data ?? []).length === 1;
}

/** Falha de envio: solta a reserva para a próxima varredura tentar de novo (nada foi entregue, então não há duplicata). */
export async function releaseAlertSlot(db: SupabaseClient, id: number): Promise<void> {
  const { error } = await db.from("exception_alert_ledger").delete().eq("id", id).eq("status", "claimed");
  if (error) throw error;
}

/** Gestores que recebem os alertas (lista explícita; vazia = nenhum gestor, nunca "todos os owners"). */
export async function listAlertRecipientIds(db: SupabaseClient, organizationId: string): Promise<string[]> {
  const { data, error } = await db.from("exception_alert_recipients").select("user_id").eq("organization_id", organizationId);
  if (error) throw error;
  return ((data ?? []) as Array<{ user_id: string }>).map(r => r.user_id);
}

/**
 * Reservas presas depois de `olderThanMs`:
 *  - SEM `send_started_at` (caiu antes de chamar o push): apagadas, o próximo ciclo reenvia com segurança;
 *  - COM `send_started_at` (o push pode ter saído; a confirmação no banco falhou): viram 'skipped' com motivo `unconfirmed_send`
 *    e NÃO são reenviadas (preferimos um aviso possivelmente já entregue a um duplicado; o estágio seguinte da escada continua valendo).
 * Nunca toca 'sent'/'skipped'.
 */
export async function releaseStaleAlertClaims(db: SupabaseClient, olderThanMs: number, now: Date = new Date()): Promise<{ released: number; unconfirmed: number }> {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  const released = await db.from("exception_alert_ledger").delete().eq("status", "claimed").eq("mode", "on").is("send_started_at", null).lt("created_at", cutoff).select("id");
  if (released.error) throw released.error;
  const unconfirmed = await db.from("exception_alert_ledger").update({ status: "skipped", detail: { reason: "unconfirmed_send" } })
    .eq("status", "claimed").eq("mode", "on").not("send_started_at", "is", null).lt("send_started_at", cutoff).select("id");
  if (unconfirmed.error) throw unconfirmed.error;
  return { released: (released.data ?? []).length, unconfirmed: (unconfirmed.data ?? []).length };
}

/** Fatos para a prontidão (só leitura): destinatários explícitos, papel de membro atual e nº de aparelhos push. */
export async function loadAlertReadinessRecipients(db: SupabaseClient, organizationId: string): Promise<Array<{ userId: string; memberRole: string | null; pushDevices: number }>> {
  const ids = await listAlertRecipientIds(db, organizationId);
  if (!ids.length) return [];
  const [members, subs] = await Promise.all([
    db.from("organization_members").select("user_id, role").eq("organization_id", organizationId).in("user_id", ids),
    db.from("push_subscriptions").select("user_id").eq("organization_id", organizationId).in("user_id", ids),
  ]);
  if (members.error) throw members.error;
  if (subs.error) throw subs.error;
  const roleById = new Map(((members.data ?? []) as Array<{ user_id: string; role: string }>).map(m => [m.user_id, m.role]));
  const devices = new Map<string, number>();
  for (const s of (subs.data ?? []) as Array<{ user_id: string }>) devices.set(s.user_id, (devices.get(s.user_id) ?? 0) + 1);
  return ids.map(userId => ({ userId, memberRole: roleById.get(userId) ?? null, pushDevices: devices.get(userId) ?? 0 }));
}
