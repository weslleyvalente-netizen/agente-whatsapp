import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTrainerSession, AgentTrainerMessage, TrainerProposal } from "@aula-agente/shared";

export async function createTrainerSession(
  client: SupabaseClient,
  params: { agentId: string; organizationId: string; createdBy: string }
): Promise<AgentTrainerSession> {
  const { data, error } = await client
    .from("agent_trainer_sessions")
    .insert({ agent_id: params.agentId, organization_id: params.organizationId, created_by: params.createdBy })
    .select()
    .single();
  if (error) throw error;
  return data as AgentTrainerSession;
}

export async function getTrainerSessionById(client: SupabaseClient, sessionId: string): Promise<AgentTrainerSession> {
  const { data, error } = await client.from("agent_trainer_sessions").select("*").eq("id", sessionId).single();
  if (error) throw error;
  return data as AgentTrainerSession;
}

export async function getTrainerMessages(client: SupabaseClient, sessionId: string): Promise<AgentTrainerMessage[]> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as AgentTrainerMessage[];
}

export async function addTrainerMessage(
  client: SupabaseClient,
  params: { sessionId: string; organizationId: string; role: "user" | "assistant"; content: string; proposals: TrainerProposal[] }
): Promise<AgentTrainerMessage> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .insert({
      session_id: params.sessionId,
      organization_id: params.organizationId,
      role: params.role,
      content: params.content,
      proposals: params.proposals,
    })
    .select()
    .single();
  if (error) throw error;
  return data as AgentTrainerMessage;
}

// Finds the one message whose `proposals` jsonb array contains an element
// with this id. jsonb `@>` containment matches array elements by partial
// object match, so `[{id: proposalId}]` correctly locates it without
// needing a dedicated proposals table.
export async function getTrainerMessageByProposalId(
  client: SupabaseClient,
  proposalId: string
): Promise<AgentTrainerMessage | null> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .select("*")
    .contains("proposals", [{ id: proposalId }])
    .maybeSingle();
  if (error) throw error;
  return data as AgentTrainerMessage | null;
}

export async function updateTrainerMessageProposals(
  client: SupabaseClient,
  messageId: string,
  proposals: TrainerProposal[]
): Promise<AgentTrainerMessage> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .update({ proposals })
    .eq("id", messageId)
    .select()
    .single();
  if (error) throw error;
  return data as AgentTrainerMessage;
}
