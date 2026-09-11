import type { SupabaseClient } from "@aula-agente/database";
import {
  getAllOrganizations,
  getAgentsByOrganization,
  getInstancesByOrganization,
  createMessage,
  updateConversation,
  upsertConversationQualification,
} from "@aula-agente/database";
import type { NormalizedWixLead } from "@aula-agente/shared";
import { resolveApiKey, runAgent } from "@aula-agente/agent-runtime";
import { ensureConversation } from "./conversation.service.js";
import { buildWixLeadTriggerMessage } from "../lib/wix-lead-message.js";
import { enqueueSendMessage } from "../lib/queue.js";

// Evolution/WhatsApp store phone numbers as plain digits with country code
// (e.g. "556293227531") — no "+", no formatting. Form submissions come in
// however the customer typed them ("+55 62 99856-1435").
export function normalizeBrazilPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("55") ? digits : `55${digits}`;
}

const ATTENDANCE_TYPE_KEYWORDS: Array<{ match: RegExp; type: "consortium" | "financing" | "cash" }> = [
  { match: /cons[oó]rcio/i, type: "consortium" },
  { match: /financiamento/i, type: "financing" },
  { match: /[aà]\s*vista/i, type: "cash" },
];

function inferAttendanceType(interest: string | undefined): "consortium" | "financing" | "cash" | null {
  if (!interest) return null;
  const found = ATTENDANCE_TYPE_KEYWORDS.find((k) => k.match.test(interest));
  return found?.type ?? null;
}

function buildCommercialNotes(lead: NormalizedWixLead): string | null {
  const parts: string[] = [];
  if (lead.budget) parts.push(`Orçamento informado: ${lead.budget}.`);
  if (lead.priorExperience) parts.push(`Já fez consórcio antes: ${lead.priorExperience}.`);
  if (parts.length === 0) return null;
  return `Lead via formulário do site. ${parts.join(" ")}`;
}

export interface IngestWixLeadResult {
  ok: true;
  skipped?: "no_agent";
  isNew?: boolean;
  sent?: boolean;
}

export async function ingestWixLead(
  db: SupabaseClient,
  lead: NormalizedWixLead
): Promise<IngestWixLeadResult> {
  const organizations = await getAllOrganizations(db);
  const org = organizations[0];
  if (!org) return { ok: true, skipped: "no_agent" };

  const agents = await getAgentsByOrganization(db, org.id);
  const agent = agents.find((a) => a.is_active);
  if (!agent) return { ok: true, skipped: "no_agent" };

  const instances = await getInstancesByOrganization(db, org.id);
  const instance = instances.find((i) => i.active_agent_id === agent.id);
  if (!instance) return { ok: true, skipped: "no_agent" };

  const phone = normalizeBrazilPhone(lead.phone);

  const { conversation, contact, isNew } = await ensureConversation({
    organizationId: org.id,
    agentId: agent.id,
    instanceId: instance.id,
    phone,
    contactName: lead.name,
    contactPhotoUrl: null,
  });

  // Already existed — either the customer already talked to us before, or
  // Wix retried the same webhook delivery. Either way, don't send a second
  // "opening" message into a conversation that's already underway. Still
  // safe/idempotent to refresh the qualification snapshot below.
  if (!isNew) {
    return { ok: true, isNew: false };
  }

  const commercialNotes = buildCommercialNotes(lead);
  if (lead.interest || commercialNotes) {
    await upsertConversationQualification(db, {
      organizationId: org.id,
      conversationId: conversation.id,
      contactId: contact.id,
      changedByType: "human",
      changedById: null,
      fields: {
        product_interest: lead.interest ?? null,
        attendance_type: inferAttendanceType(lead.interest),
        commercial_notes: commercialNotes,
      },
    });
  }

  const trigger = buildWixLeadTriggerMessage({
    conversationId: conversation.id,
    organizationId: org.id,
    lead,
  });

  const apiKey = await resolveApiKey(org.id, agent.provider);
  const result = await runAgent({
    agent,
    messages: [],
    currentMessage: trigger,
    apiKey,
    organizationId: org.id,
    conversationId: conversation.id,
    instanceId: instance.id,
    phone,
    contactId: contact.id,
    contactName: lead.name,
  });

  if (!result.text.trim()) {
    return { ok: true, isNew: true, sent: false };
  }

  const message = await createMessage(db, {
    conversation_id: conversation.id,
    organization_id: org.id,
    evolution_message_id: null,
    role: "agent",
    content: result.text,
    media_url: null,
    media_type: null,
    metadata: {
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cache_read_tokens: result.cacheReadTokens,
      cache_write_tokens: result.cacheWriteTokens,
      cache_status: result.cacheStatus,
      latency_ms: result.latencyMs,
      tool_calls: result.toolCalls,
    },
  });

  await enqueueSendMessage({
    conversationId: conversation.id,
    messageId: message.id,
    instanceId: instance.id,
    phone,
    content: result.text,
    organizationId: org.id,
  });

  await updateConversation(db, conversation.id, {
    last_message_at: new Date().toISOString(),
  });

  return { ok: true, isNew: true, sent: true };
}
