import { decideAttendanceCompleted, decideCustomerReplied, isSubstantiveCustomerMessage, type Task } from "@aula-agente/shared";
import { getOrganizationById, type SupabaseClient } from "@aula-agente/database";

const OPEN = ["pending", "in_progress", "rescheduled"];

/** Negócio aberto do contato: o da tarefa, ou o ÚNICO aberto do contato (vários = ambíguo, não adivinha). */
async function resolveOpportunity(db: SupabaseClient, organizationId: string, opportunityId: string | null, contactId: string) {
  let q = db.from("opportunities").select("id, contact_id, status, stage, waiting_on, next_action").eq("organization_id", organizationId);
  q = opportunityId ? q.eq("id", opportunityId) : q.eq("contact_id", contactId).eq("status", "open");
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; contact_id: string; status: string; stage: string; waiting_on: string | null; next_action: string | null }>;
  return rows.length === 1 ? rows[0] : null;
}

async function syncEnabled(db: SupabaseClient, organizationId: string): Promise<boolean> {
  const org = await getOrganizationById(db, organizationId);
  return org.settings?.waiting_on_sync_enabled === true;
}

/**
 * Um humano concluiu uma tarefa: se era a tarefa de atendimento do repasse (return_customer), o vendedor já respondeu o cliente na
 * conversa e nada mais está aberto no negócio, a bola passa para o cliente. Só com `waiting_on_sync_enabled === true`.
 * Nunca lança (a conclusão da tarefa é a operação principal). Devolve o motivo/resultado para log e testes.
 */
export async function syncWaitingOnAfterHumanCompletion(db: SupabaseClient, task: Task): Promise<string> {
  try {
    if (!(await syncEnabled(db, task.organization_id))) return "disabled";
    const opp = await resolveOpportunity(db, task.organization_id, task.opportunity_id, task.contact_id);
    if (!opp) return "no_single_open_opportunity";
    let humanReplied = false;
    if (task.conversation_id) {
      const { data, error } = await db.from("messages").select("id").eq("organization_id", task.organization_id).eq("conversation_id", task.conversation_id)
        .eq("role", "human_agent").gt("created_at", task.created_at).limit(1);
      if (error) throw error;
      humanReplied = (data ?? []).length > 0;
    }
    const { data: others, error: oErr } = await db.from("tasks").select("id").eq("organization_id", task.organization_id).in("status", OPEN)
      .or(`opportunity_id.eq.${opp.id},contact_id.eq.${opp.contact_id}`).neq("id", task.id).limit(1);
    if (oErr) throw oErr;
    const decision = decideAttendanceCompleted({
      opportunity: opp, completedTypes: [task.type, ...(task.consolidated_pendencies ?? []).map((p) => p.type)],
      humanRepliedAfterTaskCreated: humanReplied, otherOpenTasks: (others ?? []).length,
    });
    if (decision.action === "keep") return decision.reason;
    const { error } = await db.from("opportunities").update({ waiting_on: decision.waiting_on, next_action: decision.next_action })
      .eq("id", opp.id).eq("organization_id", task.organization_id).eq("waiting_on", "team").eq("next_action", opp.next_action ?? "");
    if (error) throw error;
    return "set_customer";
  } catch (err) {
    console.error("waiting_on sync (task completed) failed:", err);
    return "error";
  }
}

/** Resposta do cliente: se o "Aguardando cliente" foi posto pela regra acima e a resposta é substantiva, a bola volta para a equipe. */
export async function syncWaitingOnAfterCustomerReply(
  db: SupabaseClient, input: { organizationId: string; contactId: string; role: string; content: string | null },
): Promise<string> {
  try {
    if (input.role !== "contact") return "not_customer";
    if (!(await syncEnabled(db, input.organizationId))) return "disabled";
    const opp = await resolveOpportunity(db, input.organizationId, null, input.contactId);
    if (!opp) return "no_single_open_opportunity";
    const decision = decideCustomerReplied({ opportunity: opp, substantive: isSubstantiveCustomerMessage(input.content) });
    if (decision.action === "keep") return decision.reason;
    const { error } = await db.from("opportunities").update({ waiting_on: decision.waiting_on, next_action: decision.next_action })
      .eq("id", opp.id).eq("organization_id", input.organizationId).eq("waiting_on", "customer").eq("next_action", opp.next_action ?? "");
    if (error) throw error;
    return "set_team";
  } catch (err) {
    console.error("waiting_on sync (customer reply) failed:", err);
    return "error";
  }
}
