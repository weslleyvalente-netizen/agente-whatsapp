import {
  classifyCustomerReply, classifySellerMessage, decideAttendanceCompleted, decideCustomerReplied, decideSellerMessage, NON_BLOCKING_TASK_TYPES,
  resolveWaitingOnSyncMode, type Task, type WaitingOnSyncMode,
} from "@aula-agente/shared";
import { getOrganizationById, type SupabaseClient } from "@aula-agente/database";

const OPEN = ["pending", "in_progress", "rescheduled"];
const todayBR = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

interface Opp { id: string; contact_id: string; status: string; stage: string; waiting_on: string | null; next_action: string | null; frozen_until: string | null; waiting_on_until: string | null }
type Decision = { action: "keep"; reason: string } | { action: "set_customer" | "set_team"; waiting_on: "customer" | "team"; next_action: string; rule: string; reason: string };
type Trigger = { trigger: "task_completed" | "customer_message" | "seller_message"; messageId?: string | null; taskId?: string | null };

/** Negócio aberto do contato: o da tarefa, ou o ÚNICO aberto do contato (vários = ambíguo, não adivinha). */
async function resolveOpportunity(db: SupabaseClient, organizationId: string, opportunityId: string | null, contactId: string): Promise<Opp | null> {
  let q = db.from("opportunities").select("id, contact_id, status, stage, waiting_on, next_action, frozen_until, waiting_on_until").eq("organization_id", organizationId);
  q = opportunityId ? q.eq("id", opportunityId) : q.eq("contact_id", contactId).eq("status", "open");
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Opp[];
  return rows.length === 1 ? rows[0] : null;
}

async function syncMode(db: SupabaseClient, organizationId: string): Promise<WaitingOnSyncMode> {
  const org = await getOrganizationById(db, organizationId);
  return resolveWaitingOnSyncMode(org.settings);
}

/** Tarefas abertas do negócio que são obrigação da EQUIPE (simulação, documentos, retorno agendado, financiamento...). Alertas de silêncio não contam. */
async function blockingOpenTasks(db: SupabaseClient, organizationId: string, opp: Opp, excludeTaskId?: string | null): Promise<number> {
  let q = db.from("tasks").select("id, type, consolidated_pendencies").eq("organization_id", organizationId).in("status", OPEN)
    .or(`opportunity_id.eq.${opp.id},contact_id.eq.${opp.contact_id}`);
  if (excludeTaskId) q = q.neq("id", excludeTaskId);
  const { data, error } = await q.limit(50);
  if (error) throw error;
  return ((data ?? []) as Array<{ type: string; consolidated_pendencies?: Array<{ type: string }> | null }>).filter((t) => {
    const types = [t.type, ...(t.consolidated_pendencies ?? []).map((p) => p.type)];
    return !types.every((x) => NON_BLOCKING_TASK_TYPES.includes(x));
  }).length;
}

let warnedShadowTable = false;
/** Modo sombra: registra o que a regra FARIA, sem tocar no negócio. Sem a tabela (migração ainda não aplicada), cai para uma linha de log. */
async function recordShadow(db: SupabaseClient, organizationId: string, opp: Opp, d: Extract<Decision, { waiting_on: string }>, t: Trigger): Promise<void> {
  const row = {
    organization_id: organizationId, opportunity_id: opp.id, rule: d.rule, trigger: t.trigger,
    would_set: { waiting_on: d.waiting_on, next_action: d.next_action },
    observed: { waiting_on: opp.waiting_on, next_action: opp.next_action, stage: opp.stage },
    evidence: `${d.reason}${t.messageId ? ` [mensagem ${t.messageId}]` : ""}${t.taskId ? ` [tarefa ${t.taskId}]` : ""}`,
  };
  try {
    const { error } = await db.from("waiting_on_sync_shadow").insert(row);
    if (error) throw error;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if ((code === "42P01" || code === "PGRST205") && !warnedShadowTable) { warnedShadowTable = true; console.warn("waiting_on sync (shadow): tabela waiting_on_sync_shadow ausente; registrando só em log"); }
    else if (code !== "42P01" && code !== "PGRST205") console.error("waiting_on sync (shadow): falha ao registrar", (err as Error)?.message);
    console.log(`waiting-on-sync[shadow] ${JSON.stringify(row)}`);
  }
}

/** Aplica (modo "on") ou registra (modo "shadow") a decisão. Atualização com guarda otimista; evento waiting_on_changed com origem, motivo e valores. */
async function applyDecision(db: SupabaseClient, mode: WaitingOnSyncMode, organizationId: string, opp: Opp, d: Decision, t: Trigger): Promise<string> {
  if (d.action === "keep") return d.reason;
  if (mode === "shadow") { await recordShadow(db, organizationId, opp, d, t); return `shadow:${d.rule}`; }
  const { data, error } = await db.from("opportunities").update({ waiting_on: d.waiting_on, next_action: d.next_action })
    .eq("id", opp.id).eq("organization_id", organizationId).eq("waiting_on", opp.waiting_on ?? "").eq("next_action", opp.next_action ?? "").select("id");
  if (error) throw error;
  if (!data || data.length === 0) return "changed_meanwhile"; // alguém (humano) mexeu entre a leitura e a escrita: vence
  try {
    const { error: evErr } = await db.from("opportunity_events").insert({
      organization_id: organizationId, opportunity_id: opp.id, event_type: "waiting_on_changed",
      previous_value: { waiting_on: opp.waiting_on, next_action: opp.next_action }, new_value: { waiting_on: d.waiting_on, next_action: d.next_action },
      evidence: `origem=${t.trigger}; regra=${d.rule}; motivo=${d.reason}${t.messageId ? `; mensagem=${t.messageId}` : ""}${t.taskId ? `; tarefa=${t.taskId}` : ""}`,
      changed_by_type: "system",
    });
    if (evErr) throw evErr;
  } catch (err) { console.error("waiting_on sync: mudança aplicada, mas o evento waiting_on_changed falhou:", (err as Error)?.message); }
  return d.action;
}

/**
 * Um humano concluiu uma tarefa: se era a tarefa de atendimento do repasse, o vendedor já respondeu o cliente e a última mensagem
 * NÃO é do cliente, a bola passa para o cliente. Nunca lança (a conclusão da tarefa é a operação principal).
 */
export async function syncWaitingOnAfterHumanCompletion(db: SupabaseClient, task: Task): Promise<string> {
  try {
    const mode = await syncMode(db, task.organization_id);
    if (mode === "off") return "disabled";
    const opp = await resolveOpportunity(db, task.organization_id, task.opportunity_id, task.contact_id);
    if (!opp) return "no_single_open_opportunity";
    let humanReplied = false; let lastRole: string | null = null;
    if (task.conversation_id) {
      const { data, error } = await db.from("messages").select("id").eq("organization_id", task.organization_id).eq("conversation_id", task.conversation_id)
        .eq("role", "human_agent").gt("created_at", task.created_at).limit(1);
      if (error) throw error;
      humanReplied = (data ?? []).length > 0;
      const { data: last, error: lErr } = await db.from("messages").select("role").eq("organization_id", task.organization_id).eq("conversation_id", task.conversation_id)
        .order("created_at", { ascending: false }).limit(1);
      if (lErr) throw lErr;
      lastRole = (last as Array<{ role: string }> | null)?.[0]?.role ?? null;
    }
    const others = await blockingOpenTasks(db, task.organization_id, opp, task.id);
    const decision = decideAttendanceCompleted({
      opportunity: opp, completedTypes: [task.type, ...(task.consolidated_pendencies ?? []).map((p) => p.type)],
      humanRepliedAfterTaskCreated: humanReplied, otherOpenTasks: others, lastMessageRole: lastRole, today: todayBR(),
    });
    return await applyDecision(db, mode, task.organization_id, opp, decision, { trigger: "task_completed", taskId: task.id });
  } catch (err) {
    console.error("waiting_on sync (task completed) failed:", err);
    return "error";
  }
}

/** O cliente respondeu. "Aguardando cliente" posto pela regra volta para a equipe; "não" tem texto próprio e não presume interesse. */
export async function syncWaitingOnAfterCustomerReply(
  db: SupabaseClient, input: { organizationId: string; contactId: string; role: string; content: string | null; mediaType?: string | null; messageId?: string | null },
): Promise<string> {
  try {
    if (input.role !== "contact") return "not_customer";
    const mode = await syncMode(db, input.organizationId);
    if (mode === "off") return "disabled";
    const opp = await resolveOpportunity(db, input.organizationId, null, input.contactId);
    if (!opp) return "no_single_open_opportunity";
    const decision = decideCustomerReplied({ opportunity: opp, reply: classifyCustomerReply(input.content, input.mediaType), today: todayBR() });
    return await applyDecision(db, mode, input.organizationId, opp, decision, { trigger: "customer_message", messageId: input.messageId });
  } catch (err) {
    console.error("waiting_on sync (customer reply) failed:", err);
    return "error";
  }
}

/**
 * O vendedor (humano) escreveu: proposta ou pergunta => aguardando cliente; promessa de verificar/enviar => equipe.
 * Só sobre os textos automáticos, sem obrigação da equipe aberta, fora de etapa da equipe/congelado/data combinada. Nunca lança.
 */
export async function syncWaitingOnAfterSellerMessage(
  db: SupabaseClient, input: { organizationId: string; contactId: string; role: string; content: string | null; mediaType?: string | null; messageId?: string | null },
): Promise<string> {
  try {
    if (input.role !== "human_agent") return "not_seller";
    const mode = await syncMode(db, input.organizationId);
    if (mode === "off") return "disabled";
    const opp = await resolveOpportunity(db, input.organizationId, null, input.contactId);
    if (!opp) return "no_single_open_opportunity";
    const kind = classifySellerMessage(input.content, input.mediaType);
    if (kind === "ack" || kind === "info" || kind === "media_audio") return "no_change"; // nem consulta tarefas
    const blocking = await blockingOpenTasks(db, input.organizationId, opp);
    const decision = decideSellerMessage({ opportunity: opp, kind, blockingOpenTasks: blocking, today: todayBR() });
    return await applyDecision(db, mode, input.organizationId, opp, decision, { trigger: "seller_message", messageId: input.messageId });
  } catch (err) {
    console.error("waiting_on sync (seller message) failed:", err);
    return "error";
  }
}
