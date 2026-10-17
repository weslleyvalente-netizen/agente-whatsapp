import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION,
  isBusinessOpen,
  handoffStartedTakeover,
  lastBusinessClosing,
  nextBusinessOpening,
  describeBusinessInstant,
  resolveBusinessCalendar,
  shouldRunAiAfterHours,
} from "@aula-agente/shared";
import { getOrganizationById, getOpenHandoffEvent, countAfterHoursAgentReplies } from "@aula-agente/database";

export type AfterHoursDecision =
  | { run: true; capped: boolean; handedAt: string; reopensAt: string | null }
  | { run: false };

// Reavalia o "modo noite" com dados frescos do banco (o sinal do job é só
// uma dica). Falha fechado: qualquer erro de consulta => não roda.
export async function evaluateAfterHours(
  db: SupabaseClient,
  params: { organizationId: string; conversationId: string; isHumanTakeover: boolean; humanTakeoverAt: string | null; aiDisabled: boolean; now?: Date }
): Promise<AfterHoursDecision> {
  if (!params.isHumanTakeover) return { run: false };
  try {
    const org = await getOrganizationById(db, params.organizationId);
    const flagEnabled = org.settings?.ai_after_hours_pending_enabled === true;
    if (!flagEnabled) return { run: false };
    const handoff = await getOpenHandoffEvent(db, params.conversationId);
    const now = params.now ?? new Date();
    const calendar = resolveBusinessCalendar(org.settings?.business_calendar);
    const ok = shouldRunAiAfterHours({
      isHumanTakeover: params.isHumanTakeover,
      hasOpenRequestHumanHandoff: !!handoff,
      takeoverOriginatedFromHandoff: handoffStartedTakeover(handoff?.handed_at, params.humanTakeoverAt),
      businessOpen: isBusinessOpen(now, calendar),
      aiDisabled: params.aiDisabled,
      flagEnabled,
    });
    if (!ok || !handoff) return { run: false };
    // The cap is per closed stretch ("por noite"): count from the later of the
    // handoff and the last time the store closed.
    const closing = lastBusinessClosing(now, calendar);
    const since = closing && closing.getTime() > Date.parse(handoff.handed_at) ? closing.toISOString() : handoff.handed_at;
    const used = await countAfterHoursAgentReplies(db, params.conversationId, since);
    const next = nextBusinessOpening(now, calendar);
    return {
      run: true,
      capped: used >= AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION,
      handedAt: handoff.handed_at,
      reopensAt: next ? describeBusinessInstant(next, calendar) : null,
    };
  } catch (err) {
    console.error("[after-hours] evaluation failed, staying silent", params.conversationId, err);
    return { run: false };
  }
}
