import { getAdminClient } from "@aula-agente/database";
import {
  findOpenConversation,
  createConversation,
  updateConversation,
} from "@aula-agente/database";
import { upsertContact, getOrganizationById } from "@aula-agente/database";
import {
  resolveReturningCustomerOwnership,
  createReturningCustomerDeps,
  type ReturningCustomerOwnership,
} from "./returning-customer.service.js";

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

  // Cliente que volta depois de uma conversa resolvida/fechada: mantém o vendedor anterior (se o vínculo ainda vale) e,
  // até 24 h depois de atendimento humano, nasce em takeover para a MarIAna não assumir sozinha. Conversas antigas não são alteradas.
  const inherited = await resolveInheritedOwnership(db, params.organizationId, contact.id);

  // Create new conversation
  const conversation = await createConversation(db, {
    organization_id: params.organizationId,
    agent_id: params.agentId,
    evolution_instance_id: params.instanceId,
    contact_id: contact.id,
    status: "open",
    is_human_takeover: inherited?.keepHumanTakeover ?? false,
    human_takeover_at: inherited?.keepHumanTakeover ? new Date().toISOString() : null,
    assigned_to: inherited?.assignedTo ?? null,
    tags: [],
    last_message_at: new Date().toISOString(),
  });

  return { conversation, contact, isNew: true };
}

/** Chave de desligamento: `returning_customer_owner_enabled: false` nas configurações da organização volta ao comportamento antigo. */
async function resolveInheritedOwnership(
  db: ReturnType<typeof getAdminClient>,
  organizationId: string,
  contactId: string,
): Promise<ReturningCustomerOwnership | null> {
  try {
    const org = await getOrganizationById(db, organizationId);
    if ((org.settings as { returning_customer_owner_enabled?: boolean } | null)?.returning_customer_owner_enabled === false) return null;
    return await resolveReturningCustomerOwnership(createReturningCustomerDeps(db), { organizationId, contactId });
  } catch (err) {
    console.error("conversation: falha ao herdar responsável do cliente que voltou; criando sem dono", err);
    return null;
  }
}

export async function setHumanTakeover(conversationId: string, takeover: boolean) {
  const db = getAdminClient();
  return updateConversation(db, conversationId, {
    is_human_takeover: takeover,
    human_takeover_at: takeover ? new Date().toISOString() : null,
  });
}
