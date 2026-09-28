// Fase 2 (triagem de tarefas), item 1(b): backfill de opportunity_id nas
// tarefas ABERTAS atuais, usando a mesma regra do auto-link em
// createTaskWithDedup (packages/database/src/queries/tasks.ts) —
// resolveOpportunityAutoLink (packages/shared): só vincula quando o
// contato tem EXATAMENTE 1 oportunidade aberta.
//
// Uso:
//   pnpm --filter @aula-agente/database exec tsx scripts/backfill-task-opportunity-links.ts --dry-run   (padrão)
//   pnpm --filter @aula-agente/database exec tsx scripts/backfill-task-opportunity-links.ts --apply
//
// --dry-run (padrão, sem escrita nenhuma): imprime as contagens —
// quantas tarefas abertas têm opportunity_id nulo, quantas têm 0/1/2+
// oportunidades abertas para o contato.
// --apply: roda o UPDATE só nos casos "exatamente 1", um a um (não é uma
// transação única — cada tarefa tocada grava seu próprio task_events, então
// uma falha no meio não deixa nada inconsistente, só incompleto: rodar de
// novo é seguro, tarefas já vinculadas não aparecem mais como candidatas).
import { createClient } from "@supabase/supabase-js";
import { resolveOpportunityAutoLink } from "@aula-agente/shared";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const apply = process.argv.includes("--apply");
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tasks, error: tasksError } = await client
    .from("tasks")
    .select("id, contact_id, type, organization_id")
    .is("opportunity_id", null)
    .in("status", ["pending", "in_progress", "rescheduled"]);
  if (tasksError) throw tasksError;

  const { data: opportunities, error: oppError } = await client
    .from("opportunities")
    .select("id, contact_id")
    .eq("status", "open");
  if (oppError) throw oppError;

  const openOpportunityIdsByContact = new Map<string, string[]>();
  for (const o of opportunities ?? []) {
    const list = openOpportunityIdsByContact.get(o.contact_id) ?? [];
    list.push(o.id);
    openOpportunityIdsByContact.set(o.contact_id, list);
  }

  let zeroOpen = 0;
  let exactlyOne = 0;
  let twoPlus = 0;
  const byTypeWhenOne: Record<string, number> = {};
  const linkable: Array<{ taskId: string; organizationId: string; opportunityId: string }> = [];

  for (const task of tasks ?? []) {
    const openIds = openOpportunityIdsByContact.get(task.contact_id) ?? [];
    const linked = resolveOpportunityAutoLink(openIds);
    if (openIds.length === 0) zeroOpen++;
    else if (openIds.length === 1) {
      exactlyOne++;
      byTypeWhenOne[task.type] = (byTypeWhenOne[task.type] ?? 0) + 1;
    } else twoPlus++;

    if (linked) {
      linkable.push({ taskId: task.id, organizationId: task.organization_id, opportunityId: linked });
    }
  }

  console.log(`Tarefas abertas com opportunity_id nulo: ${tasks?.length ?? 0}`);
  console.log(`  -> contato com 0 oportunidades abertas: ${zeroOpen}`);
  console.log(`  -> contato com exatamente 1 (vinculável): ${exactlyOne}`);
  console.log(`  -> contato com 2+ (ambíguo, não vincula): ${twoPlus}`);
  console.log(`Por tipo (grupo vinculável):`, byTypeWhenOne);

  if (!apply) {
    console.log("\n--dry-run (padrão): nada foi escrito. Rode com --apply para aplicar.");
    return;
  }

  console.log(`\n--apply: vinculando ${linkable.length} tarefa(s)...`);
  let done = 0;
  for (const { taskId, organizationId, opportunityId } of linkable) {
    const { error: updateError } = await client
      .from("tasks")
      .update({ opportunity_id: opportunityId })
      .eq("id", taskId);
    if (updateError) {
      console.error(`Falha ao vincular tarefa ${taskId}:`, updateError.message);
      continue;
    }
    const { error: eventError } = await client.from("task_events").insert({
      task_id: taskId,
      organization_id: organizationId,
      event_type: "opportunity_auto_linked",
      note: "Backfill (Fase 2, item 1b) — vinculada à única oportunidade aberta do contato.",
      created_by_type: "ai",
      created_by_id: null,
    });
    if (eventError) {
      console.error(`Tarefa ${taskId} vinculada, mas falhou ao gravar o evento:`, eventError.message);
    }
    done++;
  }
  console.log(`Concluído: ${done}/${linkable.length} tarefas vinculadas.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
