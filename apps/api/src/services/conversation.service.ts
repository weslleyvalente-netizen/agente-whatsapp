import { getAdminClient } from "@aula-agente/database";
import {
  findOpenConversation,
  createConversation,
  updateConversation,
} from "@aula-agente/database";
import { upsertContact } from "@aula-agente/database";

interface EnsureConversationParams {
  organizationId: string;
  agentId: string;
  instanceId: string;
  phone: string;
  contactName: string | null;
  contactPhotoUrl: string | null;
}

export async function ensureConversation(params: EnsureConversationParams) {
  const db = getAdminClient();

  // Upsert contact
  const contact = await upsertContact(
    db,
    params.organizationId,
    params.phone,
    params.contactName,
    params.contactPhotoUrl
  );

  // Find existing open conversation
  const existing = await findOpenConversation(db, contact.id, params.agentId);

  if (existing) {
    return { conversation: existing, contact, isNew: false };
  }

  // Create new conversation
  const conversation = await createConversation(db, {
    organization_id: params.organizationId,
    agent_id: params.agentId,
    evolution_instance_id: params.instanceId,
    contact_id: contact.id,
    status: "open",
    is_human_takeover: false,
    human_takeover_at: null,
    assigned_to: null,
    tags: [],
    last_message_at: new Date().toISOString(),
  });

  return { conversation, contact, isNew: true };
}

export async function setHumanTakeover(conversationId: string, takeover: boolean) {
  const db = getAdminClient();
  return updateConversation(db, conversationId, {
    is_human_takeover: takeover,
    human_takeover_at: takeover ? new Date().toISOString() : null,
  });
}
