import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION,
  isBusinessOpen,
  resolveBusinessCalendar,
  shouldRunAiAfterHours,
} from "@aula-agente/shared";
import { getOrganizationById, getOpenHandoffEvent, countAfterHoursAgentReplies } from "@aula-agente/database";

export type AfterHoursDecision =
  | { run: true; capped: false; handedAt: string }
  | { run: true; capped: true; handedAt: string }
  | { run: false };

// Reavalia o "modo noite" com dados frescos do banco (o sinal do job é só
// uma dica). Falha fechado: qualquer erro de consulta => não roda.
export async function evaluateAfterHours(
  db: SupabaseClient,
  params: { organizationId: string; conversationId: string; isHumanTakeover: boolean; aiDisabled: boolean; now?: Date }
): Promise<AfterHoursDecision> {
  if (!params.isHumanTakeover) return { run: false };
  try {
    const org = await getOrganizationById(db, params.organizationId);
    const flagEnabled = org.settings?.ai_after_hours_pending_enabled === true;
    if (!flagEnabled) return { run: false };
    const handoff = await getOpenHandoffEvent(db, params.conversationId);
    const ok = shouldRunAiAfterHours({
      isHumanTakeover: params.isHumanTakeover,
      hasOpenRequestHumanHandoff: !!handoff,
      businessOpen: isBusinessOpen(params.now ?? new Date(), resolveBusinessCalendar(org.settings?.business_calendar)),
      aiDisabled: params.aiDisabled,
      flagEnabled,
    });
    if (!ok || !handoff) return { run: false };
    const used = await countAfterHoursAgentReplies(db, params.conversationId, handoff.handed_at);
    return { run: true, capped: used >= AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION, handedAt: handoff.handed_at };
  } catch (err) {
    console.error("[after-hours] evaluation failed, staying silent", params.conversationId, err);
    return { run: false };
  }
}
