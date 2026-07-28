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
//
// Uses `.filter(column, "cs", JSON.stringify(value))` rather than
// `.contains(column, value)`: postgrest-js's `.contains()` special-cases a
// JS array argument as a Postgres *native array* column and serializes it
// via `` `{${value.join(',')}}` `` — for an array of objects that calls
// `Object.prototype.toString` on each element, producing the literal
// string "{[object Object]}", which Postgres rejects with "invalid input
// syntax for type json". `.filter()` does no such branching, so
// pre-serializing the value ourselves sends the correct JSON array (e.g.
// `cs.[{"id":"..."}]`) that jsonb containment expects.
export async function getTrainerMessageByProposalId(
  client: SupabaseClient,
  proposalId: string
): Promise<AgentTrainerMessage | null> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .select("*")
    .filter("proposals", "cs", JSON.stringify([{ id: proposalId }]))
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
