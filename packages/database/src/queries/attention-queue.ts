import type { AttentionCandidate } from "@aula-agente/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * "Precisam de resposta" (somente leitura): chama public.attention_queue_candidates, que lê só conversas recentes e usa os
 * índices de messages (nunca varre a tabela). `sinceISO` limita a janela (ex.: 30 dias); `limit` limita cada lista.
 */
export async function listAttentionCandidates(
  client: SupabaseClient,
  organizationId: string,
  sinceISO: string,
  limit = 200,
): Promise<AttentionCandidate[]> {
  const { data, error } = await client.rpc("attention_queue_candidates", { p_org: organizationId, p_since: sinceISO, p_limit: limit });
  if (error) throw error;
  return (data ?? []) as AttentionCandidate[];
}
