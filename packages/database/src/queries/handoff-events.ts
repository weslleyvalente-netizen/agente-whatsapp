import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandoffEvent, HandoffTriggerType, HandoffMotivo, HandoffUrgencia, HandoffActorType } from "@aula-agente/shared";

export async function createHandoffEvent(
  client: SupabaseClient,
  input: {
    organization_id: string;
    conversation_id: string;
    trigger_type: HandoffTriggerType;
    motivo?: HandoffMotivo | null;
    resumo?: string | null;
    urgencia?: HandoffUrgencia | null;
    criado_por: HandoffActorType;
  }
) {
  const { data, error } = await client
    .from("handoff_events")
    .insert({
      organization_id: input.organization_id,
      conversation_id: input.conversation_id,
      trigger_type: input.trigger_type,
      motivo: input.motivo ?? null,
      resumo: input.resumo ?? null,
      urgencia: input.urgencia ?? null,
      criado_por: input.criado_por,
    })
    .select()
    .single();
  if (error) throw error;
  return data as HandoffEvent;
}

// The most recent still-open requestHuman handoff for a conversation, if
// any -- "open" meaning the AI asked for a human and no human has replied
// yet. Only request_human has a meaningful separate "first reply" moment
// (painel_manual/fromMe_real ARE themselves the human's reply). Called from
// messages/send.ts and evolution.ts's fromMe branch on every real human
// reply, to close the loop with markFirstHumanReply and measure time-to-
// first-response for Fase 4.
export async function getOpenHandoffEvent(client: SupabaseClient, conversationId: string) {
  const { data, error } = await client
    .from("handoff_events")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("trigger_type", "request_human")
    .is("first_human_reply_at", null)
    .order("handed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as HandoffEvent | null;
}

export async function markFirstHumanReply(client: SupabaseClient, handoffEventId: string, at: string) {
  const { error } = await client
    .from("handoff_events")
    .update({ first_human_reply_at: at })
    .eq("id", handoffEventId)
    .is("first_human_reply_at", null);
  if (error) throw error;
}

// Conversation ids currently in an open request_human handoff -- these must
// never auto-resume on the normal HUMAN_TAKEOVER_TIMEOUT_MS timer (see
// getExpiredTakeovers); they resolve only via a real human reply or the
// unanswered-handoff alert.
export async function getConversationIdsWithOpenRequestHumanHandoff(client: SupabaseClient) {
  const { data, error } = await client
    .from("handoff_events")
    .select("conversation_id")
    .eq("trigger_type", "request_human")
    .is("first_human_reply_at", null);
  if (error) throw error;
  return new Set((data as Array<{ conversation_id: string }>).map((row) => row.conversation_id));
}

// Feeds the painel "Handoffs aguardando" card: every open request_human
// handoff, oldest first, so the longest wait shows at the top.
export async function getPendingHandoffs(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("handoff_events")
    .select("*, conversations(id, contact_id, wa_contacts(name, phone))")
    .eq("organization_id", organizationId)
    .eq("trigger_type", "request_human")
    .is("first_human_reply_at", null)
    .order("handed_at", { ascending: true });
  if (error) throw error;
  return data;
}
