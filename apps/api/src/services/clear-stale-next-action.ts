import type { SupabaseClient } from "@aula-agente/database";

const OPEN = ["pending", "in_progress", "rescheduled"];

/**
 * Depois de concluir/cancelar uma tarefa: se o negócio ficou sem tarefa aberta e a "data da próxima ação" já venceu (ou é hoje),
 * limpa a data. Sem isso o card continua em "Compromissos de hoje" mesmo com tudo resolvido.
 * Nunca falha a operação principal: erros são engolidos (a limpeza é só conveniência de fila).
 */
export async function clearStaleNextAction(
  db: SupabaseClient,
  task: { organization_id: string; contact_id: string | null; opportunity_id: string | null },
  now: Date = new Date()
): Promise<boolean> {
  try {
    const today = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    let query = db.from("opportunities").select("id,contact_id,next_action_due_date,frozen_until").eq("organization_id", task.organization_id).eq("status", "open");
    query = task.opportunity_id ? query.eq("id", task.opportunity_id) : task.contact_id ? query.eq("contact_id", task.contact_id) : query.eq("id", "00000000-0000-0000-0000-000000000000");
    const { data: opps } = await query;
    if (!opps || opps.length !== 1) return false; // sem negócio, ou contato com vários negócios abertos: não adivinhar
    const opp = opps[0] as { id: string; contact_id: string; next_action_due_date: string | null; frozen_until: string | null };
    if (!opp.next_action_due_date || opp.next_action_due_date > today) return false;
    if (opp.frozen_until && opp.frozen_until > today) return false;
    const { data: remaining } = await db.from("tasks").select("id").eq("organization_id", task.organization_id).in("status", OPEN)
      .or(`opportunity_id.eq.${opp.id},contact_id.eq.${opp.contact_id}`).limit(1);
    if (remaining && remaining.length > 0) return false;
    const { error } = await db.from("opportunities").update({ next_action_due_date: null }).eq("id", opp.id).eq("organization_id", task.organization_id);
    return !error;
  } catch {
    return false;
  }
}
