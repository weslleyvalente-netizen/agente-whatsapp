import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, getOrCreateAgentConfig, addPlaygroundMessage, getPlaygroundMessages } from "@aula-agente/database";
import { resolveApiKey, runAgent } from "@aula-agente/agent-runtime";
import { compileSystemPrompt } from "@aula-agente/shared";
import type { AgentPlaygroundMessage, Message } from "@aula-agente/shared";

interface SendPlaygroundMessageParams {
  agentId: string;
  organizationId: string;
  sessionId: string;
  content: string;
}

function toRunnerHistory(messages: AgentPlaygroundMessage[]): Message[] {
  return messages.map((m) => ({
    id: m.id,
    conversation_id: "playground",
    organization_id: m.organization_id,
    evolution_message_id: null,
    role: m.role === "user" ? "contact" : "agent",
    content: m.content,
    media_url: null,
    media_type: null,
    metadata: null,
    created_at: m.created_at,
  }));
}

export async function sendPlaygroundMessage(
  db: SupabaseClient,
  params: SendPlaygroundMessageParams
): Promise<AgentPlaygroundMessage> {
  const agent = await getAgentById(db, params.agentId);
  const draft = await getOrCreateAgentConfig(db, agent);
  const priorMessages = await getPlaygroundMessages(db, params.sessionId);

  await addPlaygroundMessage(db, {
    sessionId: params.sessionId,
    organizationId: params.organizationId,
    role: "user",
    content: params.content,
  });

  const compiledPrompt = compileSystemPrompt({
    identity: draft.identity,
    personality: draft.personality,
    rules: draft.rules,
    knowledge: draft.knowledge,
    playbook: draft.playbook,
  });

  const apiKey = await resolveApiKey(params.organizationId, draft.model_settings.provider);

  const result = await runAgent({
    agent: { ...agent, system_prompt: compiledPrompt, ...draft.model_settings, tools_config: draft.tools_config },
    messages: toRunnerHistory(priorMessages),
    currentMessage: {
      id: "playground-current", conversation_id: "playground", organization_id: params.organizationId,
      evolution_message_id: null, role: "contact", content: params.content,
      media_url: null, media_type: null, metadata: null, created_at: new Date().toISOString(),
    },
    apiKey,
    organizationId: params.organizationId,
    conversationId: "playground",
    instanceId: "playground",
    phone: "0000000000",
    contactId: "playground",
    sandbox: true,
  });

  return addPlaygroundMessage(db, {
    sessionId: params.sessionId,
    organizationId: params.organizationId,
    role: "assistant",
    content: result.text,
    toolCalls: result.toolCallTrace,
  });
}
