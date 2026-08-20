import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiUsageEvent, AiUsageSource } from "@aula-agente/shared";

export async function recordAiUsageEvent(
  client: SupabaseClient,
  params: {
    organizationId: string;
    agentId: string;
    source: AiUsageSource;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }
): Promise<void> {
  const { error } = await client.from("ai_usage_events").insert({
    organization_id: params.organizationId,
    agent_id: params.agentId,
    source: params.source,
    model: params.model,
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    cache_read_tokens: params.cacheReadTokens ?? 0,
    cache_write_tokens: params.cacheWriteTokens ?? 0,
  });
  if (error) throw error;
}

export async function getAiUsageEventsForCost(
  client: SupabaseClient,
  organizationId: string
): Promise<Pick<AiUsageEvent, "created_at" | "source" | "model" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens">[]> {
  const { data, error } = await client
    .from("ai_usage_events")
    .select("created_at, source, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}
