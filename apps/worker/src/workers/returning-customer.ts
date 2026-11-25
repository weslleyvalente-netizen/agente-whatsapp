// Cliente que volta depois de negócio fechado: a cada ciclo de 15 min avalia encaminhamentos para humano e tarefas comerciais da IA
// criados desde o último ciclo. Uma decisão por gatilho (UNIQUE no banco: idempotente, reprocessar nunca duplica).
// Modo 'shadow': só grava a decisão. Modo 'write': intenção comercial cria o card (open_returning_customer_opportunity, que trava o
// grupo de identidade e reconfere duplicidade); intenção incerta vira pendência de revisão para o vendedor.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Organization } from "@aula-agente/shared";
import { createTaskWithDedup } from "@aula-agente/database";
import { ATTRIBUTION_WINDOW_MS } from "@aula-agente/shared";
import { classifyReturningIntent, decideStage, type ContextMessage, type Generate, type IntentClassification } from "../lib/returning-customer-intent.js";

export const COMMERCIAL_TASK_TYPES = ["vehicle_followup", "financing_followup", "consortium_followup", "libera_cred_resumption", "return_customer", "proposal_followup", "run_quote"];
const LOOKBACK_MS = 48 * 3600_000;
const CONTEXT_DAYS = 14;
const MAX_TRIGGERS_PER_CYCLE = 30;

export interface Trigger {
  kind: "handoff" | "task";
  id: string;
  contactId: string;
  conversationId: string | null;
  at: string;
  summary: string | null;
}

interface Previous { id: string; status: string; lost_reason: string | null; operation: string; owner_id: string | null; owner_active: boolean; closed_at: string }
interface Context { identity_ids: string[]; identity_status: "resolved" | "unresolved_lid"; open: Array<{ id: string; operation: string; operation_is_default: boolean }>; previous: Previous | null }

export interface ReturningCustomerResult { evaluated: number; created: number; review: number }

// Gatilhos ainda sem decisão: a exclusão dos já decididos acontece no banco ANTES do limite (revisão 25/11: antes, 30 gatilhos já
// decididos no começo da janela de 48 h escondiam os novos).
async function listTriggers(db: SupabaseClient, orgId: string, since: string): Promise<Trigger[]> {
  const { data, error } = await db.rpc("returning_customer_triggers", { p_org: orgId, p_since: since, p_task_types: COMMERCIAL_TASK_TYPES, p_limit: MAX_TRIGGERS_PER_CYCLE });
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({ kind: r.kind, id: r.id, contactId: r.contact_id, conversationId: r.conversation_id, at: r.at, summary: r.summary ?? null }));
}

async function loadContext(db: SupabaseClient, conversationId: string, at: string): Promise<ContextMessage[]> {
  const from = new Date(Date.parse(at) - CONTEXT_DAYS * 86400_000).toISOString();
  const { data, error } = await db.from("messages").select("id,role,content,created_at").eq("conversation_id", conversationId)
    .gte("created_at", from).lte("created_at", at).order("created_at", { ascending: false }).limit(40);
  if (error) throw error;
  return (data ?? []).reverse() as ContextMessage[];
}

// Toque de anúncio da NOVA negociação: só dentro da janela de atribuição (14 dias). A origem do cadastro vai como histórica (SQL).
async function latestAdTouch(db: SupabaseClient, orgId: string, contactId: string, now: Date): Promise<unknown> {
  try {
    const { data } = await db.from("lead_ad_touches").select("touched_at,platform,ad_id,ad_title,source_type,conversation_id").eq("organization_id", orgId).eq("contact_id", contactId)
      .gte("touched_at", new Date(now.getTime() - ATTRIBUTION_WINDOW_MS).toISOString()).order("touched_at", { ascending: false }).limit(1);
    return data?.[0] ?? null;
  } catch { return null; }
}

export async function evaluateTrigger(db: SupabaseClient, org: Pick<Organization, "id" | "settings">, trig: Trigger, generate: Generate, now = new Date()): Promise<"created" | "review" | "recorded" | "skipped"> {
  const mode = org.settings.returning_customer_card_mode === "write" ? "write" : "shadow";
  const ctxRes = await db.rpc("returning_customer_context", { p_org: org.id, p_contact: trig.contactId });
  if (ctxRes.error) throw ctxRes.error;
  const ctx = ctxRes.data as Context;
  // Contato sem negócio fechado: não é cliente que volta (os caminhos de lead novo cuidam dele).
  if (!ctx.previous || Date.parse(ctx.previous.closed_at) >= Date.parse(trig.at)) return "skipped";

  const context = trig.conversationId ? await loadContext(db, trig.conversationId, trig.at) : [];
  const sinceClose = context.filter((m) => m.role === "contact" && Date.parse(m.created_at) > Date.parse(ctx.previous!.closed_at));
  const c: IntentClassification = await classifyReturningIntent(
    { previous: ctx.previous, triggerSummary: trig.summary, context, customerMessagesSinceClose: sinceClose }, generate);

  let outcome: string;
  if (c.intent === "administrative") outcome = "skipped_not_commercial";
  else if (c.intent === "unclear") outcome = "needs_review";
  else if (ctx.open.some((o) => o.operation === c.operation || o.operation_is_default)) outcome = "skipped_open_compatible";
  else outcome = "would_create";
  const stage = c.intent === "commercial" ? decideStage(c, context) : null;

  const ins = await db.from("returning_customer_decisions").upsert({
    organization_id: org.id, contact_id: trig.contactId, conversation_id: trig.conversationId, trigger_kind: trig.kind, trigger_id: trig.id,
    mode, intent: c.intent, identity_status: ctx.identity_status, operation: c.operation, stage, reason: c.reason,
    evidence: { trigger_summary: trig.summary, customer_messages: sinceClose.slice(-5).map((m) => ({ id: m.id, at: m.created_at, text: (m.content ?? "").slice(0, 200) })),
      proposal_message_id: c.proposal_message_id, customer_gave_specifics: c.customer_gave_specifics, identity_ids: ctx.identity_ids, evaluated_at: now.toISOString() },
    previous_opportunity_id: ctx.previous.id, outcome,
  }, { onConflict: "organization_id,trigger_kind,trigger_id", ignoreDuplicates: true }).select("id");
  if (ins.error) throw ins.error;
  const decisionId = ins.data?.[0]?.id as string | undefined;
  if (!decisionId) return "skipped"; // outro processo decidiu este gatilho primeiro
  console.log("[returning-customer]", JSON.stringify({ org: org.id, decision: decisionId, trigger: `${trig.kind}:${trig.id}`, mode, intent: c.intent, operation: c.operation, stage, outcome, identity: ctx.identity_status }));

  if (mode !== "write") return "recorded";
  return completeDecision(db, org, { id: decisionId, outcome, contact_id: trig.contactId, conversation_id: trig.conversationId, reason: c.reason }, now);
}

interface PendingDecision { id: string; outcome: string; contact_id: string; conversation_id: string | null; reason: string }

// Conclusão da decisão em modo escrita (card ou tarefa de revisão). Falha => a tentativa fica registrada na decisão e o ciclo
// seguinte tenta de novo (returning_customer_pending_decisions), até 5 vezes. Idempotente: o card é criado sob trava e a decisão
// guarda o card; a revisão usa createTaskWithDedup (mesma tarefa aberta do contato) e só sai da fila com review_task_id gravado.
async function completeDecision(db: SupabaseClient, org: Pick<Organization, "id" | "settings">, d: PendingDecision, now: Date): Promise<"created" | "review" | "recorded"> {
  try {
    if (d.outcome === "would_create") {
      const r = await db.rpc("open_returning_customer_opportunity", { p_decision: d.id, p_origin: await latestAdTouch(db, org.id, d.contact_id, now) });
      if (r.error) throw new Error(r.error.message ?? String(r.error));
      return r.data ? "created" : "recorded";
    }
    if (d.outcome === "needs_review") {
      const o = await db.rpc("returning_customer_owner", { p_decision: d.id });
      if (o.error) throw new Error(o.error.message ?? String(o.error));
      const owner = (o.data as { user_id: string | null } | null)?.user_id ?? null;
      if (!owner) throw new Error("no_available_rep"); // nunca cria revisão sem responsável
      const due = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
      const { task } = await createTaskWithDedup(db, {
        organization_id: org.id, contact_id: d.contact_id, conversation_id: d.conversation_id, type: "other", priority: "normal", due_date: due,
        description: `Cliente voltou depois de negócio fechado: confirmar se é nova negociação. ${d.reason}`,
        reason: `returning_customer_review:${d.id}`, created_by_type: "ai", created_by_id: null, assignee_type: "human", assignee_id: owner,
      });
      const u = await db.from("returning_customer_decisions").update({ review_task_id: task.id }).eq("id", d.id);
      if (u?.error) throw new Error(u.error.message ?? String(u.error));
      return "review";
    }
    return "recorded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[returning-customer] conclusão falhou; nova tentativa no próximo ciclo", d.id, message);
    await db.rpc("returning_customer_mark_attempt", { p_decision: d.id, p_error: message });
    return "recorded";
  }
}

export async function runReturningCustomerCheck(db: SupabaseClient, org: Pick<Organization, "id" | "settings">, generate: Generate, now = new Date()): Promise<ReturningCustomerResult> {
  const result: ReturningCustomerResult = { evaluated: 0, created: 0, review: 0 };
  if (org.settings.returning_customer_card_enabled !== true || !org.settings.returning_customer_card_started_at) return result;
  // 1) decisões de ciclos anteriores que não concluíram (card não criado / revisão sem tarefa): só em modo escrita
  if (org.settings.returning_customer_card_mode === "write") {
    const p = await db.rpc("returning_customer_pending_decisions", { p_org: org.id, p_limit: MAX_TRIGGERS_PER_CYCLE });
    if (p.error) throw p.error;
    for (const d of (p.data ?? []) as PendingDecision[]) {
      const r = await completeDecision(db, org, d, now);
      if (r === "created") result.created++;
      if (r === "review") result.review++;
    }
  }
  // 2) gatilhos novos
  const since = new Date(Math.max(now.getTime() - LOOKBACK_MS, Date.parse(org.settings.returning_customer_card_started_at))).toISOString();
  for (const trig of await listTriggers(db, org.id, since)) {
    try {
      const r = await evaluateTrigger(db, org, trig, generate, now);
      if (r !== "skipped") result.evaluated++;
      if (r === "created") result.created++;
      if (r === "review") result.review++;
    } catch (error) {
      console.error("[returning-customer] trigger failed", trig.kind, trig.id, error);
    }
  }
  return result;
}
