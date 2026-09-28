import { DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG } from "./constants.js";

// Decides whether a LiberaCred plan-table document is stale, preferring the
// vigency date the LLM extracted from the table's own text (tableDateISO)
// over the source document's upload/edit date (documentUpdatedAtISO) — the
// text's own stated date is the real "data da tabela"; the document's
// updated_at is only a fallback when the text doesn't say. No date at all
// (neither found) is treated as outdated — never assume freshness.
export function isLiberaCredTableOutdated(
  tableDateISO: string | null,
  documentUpdatedAtISO: string | null,
  todayISODate: string,
  maxAgeDays: number
): boolean {
  const referenceDate = tableDateISO ?? documentUpdatedAtISO;
  if (!referenceDate) return true;

  const ageMs = new Date(todayISODate).getTime() - new Date(referenceDate).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return ageDays > maxAgeDays;
}

export type LiberaCredCadenceAction = "none" | "create" | "escalate" | "suggest_lost";

export interface LiberaCredCadenceParams {
  daysStalled: number;
  hasOpenResumptionTask: boolean;
  // Derived by the caller from this opportunity's task_events — same
  // idempotency principle as decideFollowupStage's stage1AlreadySent: never
  // re-fire a step that already happened for the current open task.
  escalateAlreadySent: boolean;
  suggestLostAlreadyLogged: boolean;
  createAfterDays?: number;
  escalateAfterDays?: number;
}

export function resolveLiberaCredCadenceStage(params: LiberaCredCadenceParams): LiberaCredCadenceAction {
  const createAfterDays = params.createAfterDays ?? DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.create_after_days;
  const escalateAfterDays = params.escalateAfterDays ?? DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.escalate_after_days;

  if (!params.hasOpenResumptionTask) {
    return params.daysStalled >= createAfterDays ? "create" : "none";
  }

  if (params.daysStalled < escalateAfterDays) return "none";
  if (!params.escalateAlreadySent) return "escalate";
  if (!params.suggestLostAlreadyLogged) return "suggest_lost";
  return "none";
}
