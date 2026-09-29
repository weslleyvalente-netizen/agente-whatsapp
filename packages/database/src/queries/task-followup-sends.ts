import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaskFollowupSend {
  id: string;
  organization_id: string;
  instance_id: string;
  task_id: string;
  conversation_id: string;
  message_id: string | null;
  suggestion_status: "original" | "edited";
  regenerations_before_send: number;
  sent_by_type: "human" | "system";
  sent_by_id: string | null;
  sent_at: string;
}

export async function createTaskFollowupSend(
  client: SupabaseClient,
  send: Omit<TaskFollowupSend, "id" | "sent_at">
) {
  const { data, error } = await client.from("task_followup_sends").insert(send).select().single();
  if (error) throw error;
  return data as TaskFollowupSend;
}

// Anti-ban throttle (D5): scoped by evolution_instance_id, not organization.
export async function getLastFollowupSendForInstance(client: SupabaseClient, instanceId: string) {
  const { data, error } = await client
    .from("task_followup_sends")
    .select("*")
    .eq("instance_id", instanceId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as TaskFollowupSend | null;
}

export async function countFollowupSendsForInstanceSince(
  client: SupabaseClient,
  instanceId: string,
  sinceISO: string
): Promise<number> {
  const { data, error } = await client
    .from("task_followup_sends")
    .select("id")
    .eq("instance_id", instanceId)
    .gte("sent_at", sinceISO);
  if (error) throw error;
  return (data as Array<{ id: string }>).length;
}

export interface FollowupMetrics {
  total: number;
  original: number;
  edited: number;
}

// D7: aggregate-only metrics endpoint, no dedicated report UI yet.
export async function getFollowupMetrics(
  client: SupabaseClient,
  organizationId: string,
  sinceISO: string
): Promise<FollowupMetrics> {
  const { data, error } = await client
    .from("task_followup_sends")
    .select("suggestion_status")
    .eq("organization_id", organizationId)
    .gte("sent_at", sinceISO);
  if (error) throw error;

  const rows = data as Array<{ suggestion_status: "original" | "edited" }>;
  return {
    total: rows.length,
    original: rows.filter((r) => r.suggestion_status === "original").length,
    edited: rows.filter((r) => r.suggestion_status === "edited").length,
  };
}
