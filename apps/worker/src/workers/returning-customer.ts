// Cliente que volta depois de negócio fechado: a cada ciclo de 15 min avalia encaminhamentos para humano e tarefas comerciais da IA
// criados desde o último ciclo. Uma decisão por gatilho (UNIQUE no banco: idempotente, reprocessar nunca duplica).
// Modo 'shadow': só grava a decisão. Modo 'write': intenção comercial cria o card (open_returning_customer_opportunity, que trava o
// grupo de identidade e reconfere duplicidade); intenção incerta vira pendência de revisão para o vendedor.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Organization } from "@aula-agente/shared";
import { createTaskWithDedup } from "@aula-agente/database";
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

async function listTriggers(db: SupabaseClient, orgId: string, since: string): Promise<Trigger[]> {
  const [h, t] = await Promise.all([
    db.from("handoff_events").select("id,conversation_id,handed_at,resumo,conversations!inner(contact_id)")
      .eq("organization_id", orgId).eq("trigger_type", "request_human").gte("handed_at", since).order("handed_at").limit(MAX_TRIGGERS_PER_CYCLE),
    db.from("tasks").select("id,contact_id,conversation_id,created_at,title,description")
      .eq("organization_id", orgId).eq("created_by_type", "ai").is("opportunity_id", null).in("type", COMMERCIAL_TASK_TYPES)
      .in("status", ["pending", "in_progress", "rescheduled"]).gte("created_at", since).order("created_at").limit(MAX_TRIGGERS_PER_CYCLE),
  ]);
  if (h.error) throw h.error;
  if (t.error) throw t.error;
  const triggers: Trigger[] = [
    ...(h.data ?? []).map((r: any) => ({ kind: "handoff" as const, id: r.id, contactId: r.conversations.contact_id, conversationId: r.conversation_id, at: r.handed_at, summary: r.resumo ?? null })),
    ...(t.data ?? []).map((r: any) => ({ kind: "task" as const, id: r.id, contactId: r.contact_id, conversationId: r.conversation_id, at: r.created_at, summary: [r.title, r.description].filter(Boolean).join(" — ") || null })),
  ];
  if (!triggers.length) return [];
  const done = await db.from("returning_customer_decisions").select("trigger_kind,trigger_id").eq("organization_id", orgId).in("trigger_id", triggers.map((x) => x.id));
  if (done.error) throw done.error;
  const seen = new Set((done.data ?? []).map((d: any) => `${d.trigger_kind}:${d.trigger_id}`));
  return triggers.filter((x) => !seen.has(`${x.kind}:${x.id}`)).sort((a, b) => a.at.localeCompare(b.at)).slice(0, MAX_TRIGGERS_PER_CYCLE);
}

async function loadContext(db: SupabaseClient, conversationId: string, at: string): Promise<ContextMessage[]> {
  const from = new Date(Date.parse(at) - CONTEXT_DAYS * 86400_000).toISOString();
  const { data, error } = await db.from("messages").select("id,role,content,created_at").eq("conversation_id", conversationId)
    .gte("created_at", from).lte("created_at", at).order("created_at", { ascending: false }).limit(40);
  if (error) throw error;
  return (data ?? []).reverse() as ContextMessage[];
}

async function latestAdTouch(db: SupabaseClient, orgId: string, contactId: string): Promise<unknown> {
  try {
    const { data } = await db.from("lead_ad_touches").select("touched_at,platform,ad_id,ad_title,source_type").eq("organization_id", orgId).eq("contact_id", contactId)
      .order("touched_at", { ascending: false }).limit(1);
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
  if (outcome === "would_create") {
    const r = await db.rpc("open_returning_customer_opportunity", { p_decision: decisionId, p_origin: await latestAdTouch(db, org.id, trig.contactId) });
    if (r.error) throw r.error;
    return r.data ? "created" : "recorded";
  }
  if (outcome === "needs_review") {
    const owner = ctx.previous.owner_active ? ctx.previous.owner_id : null;
    const due = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const { task } = await createTaskWithDedup(db, {
      organization_id: org.id, contact_id: trig.contactId, conversation_id: trig.conversationId, type: "other", priority: "normal", due_date: due,
      description: `Cliente voltou depois de negócio ${ctx.previous.status === "won" ? "ganho" : "perdido"}: confirmar se é nova negociação. ${c.reason}`,
      reason: `returning_customer_review:${decisionId}`, created_by_type: "ai", created_by_id: null, assignee_type: owner ? "human" : null, assignee_id: owner,
    });
    await db.from("returning_customer_decisions").update({ review_task_id: task.id }).eq("id", decisionId);
    return "review";
  }
  return "recorded";
}

export async function runReturningCustomerCheck(db: SupabaseClient, org: Pick<Organization, "id" | "settings">, generate: Generate, now = new Date()): Promise<ReturningCustomerResult> {
  const result: ReturningCustomerResult = { evaluated: 0, created: 0, review: 0 };
  if (org.settings.returning_customer_card_enabled !== true || !org.settings.returning_customer_card_started_at) return result;
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
