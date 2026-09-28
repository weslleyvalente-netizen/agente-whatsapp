import {
  DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG,
  FUNNEL_STAGES,
  computeTaskPriorityScore,
  resolveLiberaCredCadenceStage,
  toISODateInTimeZone,
  type Organization,
  type Agent,
} from "@aula-agente/shared";
import {
  getOpenLiberaCredPlanPresentedOpportunities,
  getOpenTaskByOpportunityAndType,
  getTaskEvents,
  countTaskEventsSince,
  createTaskWithDedup,
  updateTask,
  addTaskEvent,
  type SupabaseClient,
} from "@aula-agente/database";
import { resolveApiKey } from "@aula-agente/agent-runtime";
import { generateLiberaCredResumptionSuggestion } from "../lib/libera-cred-resumption-message.js";

const LIBERA_CRED_STAGE_POSITION = FUNNEL_STAGES.libera_cred.indexOf("plan_term_presented");
const LIBERA_CRED_STAGE_COUNT = FUNNEL_STAGES.libera_cred.length;

function daysSince(dateISO: string, nowMs: number): number {
  return (nowMs - new Date(dateISO).getTime()) / (24 * 60 * 60 * 1000);
}

function opportunityValue(opp: { credit_amount: number | null; sale_amount: number | null; bid_amount: number | null }) {
  return opp.credit_amount ?? opp.sale_amount ?? opp.bid_amount ?? null;
}

// Ranks "create" candidates against each other only — a simplified version
// of the real Hoje score (item 4): qualification urgency and handoff status
// aren't cheaply available per-opportunity here, so they're left neutral.
// This never affects the task's own stored priority/score, only which of
// today's 137 candidates get one of the daily quota's slots first.
function rankScore(
  opp: {
    credit_amount: number | null;
    sale_amount: number | null;
    bid_amount: number | null;
    waiting_on: string | null;
    waiting_on_until: string | null;
  },
  daysStalled: number,
  todayISODate: string
): number {
  return computeTaskPriorityScore({
    priority: "normal",
    dueDateBucket: "upcoming",
    opportunityValue: opportunityValue(opp),
    stagePosition: LIBERA_CRED_STAGE_POSITION,
    stageCount: LIBERA_CRED_STAGE_COUNT,
    daysStalled,
    waitingOn: opp.waiting_on as never,
    waitingOnUntil: opp.waiting_on_until,
    qualificationUrgency: null,
    hasUnansweredHandoff: false,
    todayISODate,
  });
}

export interface LiberaCredResumptionCheckResult {
  created: number;
  escalated: number;
  suggestedLost: number;
}

// Fase 2, item 5: cadence for opportunities stalled at libera_cred's
// plan_term_presented stage (the diagnosis's biggest, cheapest-to-unblock
// bottleneck). Called once per agent from stale-conversation-followup's
// existing 15-minute tick — no separate scheduler, same infra reused.
export async function runLiberaCredResumptionCheck(
  db: SupabaseClient,
  org: Organization,
  agent: Agent
): Promise<LiberaCredResumptionCheckResult> {
  const result: LiberaCredResumptionCheckResult = { created: 0, escalated: 0, suggestedLost: 0 };
  if (!org.settings?.libera_cred_resumption_enabled) return result;

  const windowDays = org.settings.libera_cred_resumption_window_days ?? DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.window_days;
  const tableMaxAgeDays =
    org.settings.libera_cred_table_max_age_days ?? DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.table_max_age_days;
  const dailyLimit =
    org.settings.libera_cred_resumption_daily_limit ?? DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.daily_limit;

  const now = new Date();
  const todayISODate = toISODateInTimeZone(now);
  const startOfTodayISO = `${todayISODate}T00:00:00.000Z`;

  const opportunities = await getOpenLiberaCredPlanPresentedOpportunities(db, org.id);

  const createCandidates: Array<{
    opp: (typeof opportunities)[number];
    daysStalled: number;
    score: number;
  }> = [];

  for (const opp of opportunities) {
    try {
      if (opp.waiting_on === "team" || opp.waiting_on === "bank_or_admin") continue;

      const lastInteractionISO = opp.last_interaction_at ?? opp.created_at;
      if (daysSince(lastInteractionISO, now.getTime()) > windowDays) continue;

      const anchorISO = opp.last_progress_at ?? opp.last_interaction_at ?? opp.created_at;
      const daysStalled = daysSince(anchorISO, now.getTime());

      const existingTask = await getOpenTaskByOpportunityAndType(db, org.id, opp.id, "libera_cred_resumption");
      const events = existingTask ? await getTaskEvents(db, existingTask.id) : [];
      const escalateAlreadySent = events.some((e) => e.event_type === "libera_cred_resumption_escalated");
      const suggestLostAlreadyLogged = events.some((e) => e.event_type === "libera_cred_resumption_suggest_lost");

      const action = resolveLiberaCredCadenceStage({
        daysStalled,
        hasOpenResumptionTask: !!existingTask,
        escalateAlreadySent,
        suggestLostAlreadyLogged,
      });

      if (action === "none") continue;

      if (action === "create") {
        createCandidates.push({ opp, daysStalled, score: rankScore(opp, daysStalled, todayISODate) });
        continue;
      }

      if (action === "escalate" && existingTask) {
        const suggestion = await generateLiberaCredResumptionSuggestion({
          organizationId: org.id,
          agentId: agent.id,
          provider: agent.provider,
          model: agent.model,
          apiKey: await resolveApiKey(org.id, agent.provider),
          tableMaxAgeDays,
          todayISODate,
        });
        await updateTask(db, existingTask.id, { priority: "urgent", description: suggestion.description });
        await addTaskEvent(db, {
          task_id: existingTask.id,
          organization_id: org.id,
          event_type: "libera_cred_resumption_escalated",
          note: "2ª tentativa — mensagem regerada.",
          created_by_type: "ai",
          created_by_id: null,
        });
        result.escalated++;
        continue;
      }

      if (action === "suggest_lost" && existingTask) {
        await updateTask(db, existingTask.id, {
          description: `${existingTask.description}\n\nCliente sem retorno há mais de ${DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.escalate_after_days} dias nesta etapa — considere marcar como perdida (motivo: sem_resposta).`,
        });
        await addTaskEvent(db, {
          task_id: existingTask.id,
          organization_id: org.id,
          event_type: "libera_cred_resumption_suggest_lost",
          note: "Sugestão registrada — não marcada como perdida automaticamente.",
          created_by_type: "ai",
          created_by_id: null,
        });
        result.suggestedLost++;
      }
    } catch (err) {
      console.error(`LiberaCred resumption: error processing opportunity ${opp.id}:`, err);
    }
  }

  if (createCandidates.length > 0) {
    const alreadyCreatedToday = await countTaskEventsSince(
      db,
      org.id,
      "libera_cred_resumption_created",
      startOfTodayISO
    );
    const remainingQuota = Math.max(dailyLimit - alreadyCreatedToday, 0);

    const prioritized = createCandidates.sort((a, b) => b.score - a.score).slice(0, remainingQuota);

    for (const { opp, daysStalled } of prioritized) {
      try {
        const suggestion = await generateLiberaCredResumptionSuggestion({
          organizationId: org.id,
          agentId: agent.id,
          provider: agent.provider,
          model: agent.model,
          apiKey: await resolveApiKey(org.id, agent.provider),
          tableMaxAgeDays,
          todayISODate,
        });

        const { task } = await createTaskWithDedup(db, {
          organization_id: org.id,
          contact_id: opp.contact_id,
          conversation_id: null,
          opportunity_id: opp.id,
          type: "libera_cred_resumption",
          description: suggestion.description,
          reason: `Parado há ${Math.round(daysStalled)} dias em plano e prazo apresentados (LiberaCred).`,
          priority: "high",
          due_date: todayISODate,
          created_by_type: "ai",
          created_by_id: null,
        });

        await addTaskEvent(db, {
          task_id: task.id,
          organization_id: org.id,
          event_type: "libera_cred_resumption_created",
          note: suggestion.outdated ? "Tabela não confirmada — tarefa criada só com o alerta." : null,
          created_by_type: "ai",
          created_by_id: null,
        });
        result.created++;
      } catch (err) {
        console.error(`LiberaCred resumption: error creating task for opportunity ${opp.id}:`, err);
      }
    }
  }

  return result;
}
