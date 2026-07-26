import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentPlaygroundSession, AgentPlaygroundMessage, PlaygroundToolCall } from "@aula-agente/shared";

export async function createPlaygroundSession(
  client: SupabaseClient,
  params: { agentId: string; organizationId: string; createdBy: string }
): Promise<AgentPlaygroundSession> {
  const { data, error } = await client
    .from("agent_playground_sessions")
    .insert({ agent_id: params.agentId, organization_id: params.organizationId, created_by: params.createdBy })
    .select()
    .single();
  if (error) throw error;
  return data as AgentPlaygroundSession;
}

export async function getPlaygroundSessionById(
  client: SupabaseClient,
  sessionId: string
): Promise<AgentPlaygroundSession> {
  const { data, error } = await client
    .from("agent_playground_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  if (error) throw error;
  return data as AgentPlaygroundSession;
}

export async function getPlaygroundMessages(
  client: SupabaseClient,
  sessionId: string
): Promise<AgentPlaygroundMessage[]> {
  const { data, error } = await client
    .from("agent_playground_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as AgentPlaygroundMessage[];
}

export async function addPlaygroundMessage(
  client: SupabaseClient,
  params: {
    sessionId: string;
    organizationId: string;
    role: "user" | "assistant";
    content: string;
    toolCalls?: PlaygroundToolCall[];
  }
): Promise<AgentPlaygroundMessage> {
  const { data, error } = await client
    .from("agent_playground_messages")
    .insert({
      session_id: params.sessionId,
      organization_id: params.organizationId,
      role: params.role,
      content: params.content,
      tool_calls: params.toolCalls ?? [],
    })
    .select()
    .single();
  if (error) throw error;
  return data as AgentPlaygroundMessage;
}
