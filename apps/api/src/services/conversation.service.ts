import { getAdminClient } from "@aula-agente/database";
import {
  findOpenConversation,
  createConversation,
  updateConversation,
} from "@aula-agente/database";
import { upsertContact, getOrganizationById } from "@aula-agente/database";
import { runWithTimeout } from "../lib/with-timeout.js";
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

/** Limite para a operação COMPLETA de herdar o vendedor; estourou, segue o fluxo normal (conversa sem dono) para não atrasar a MarIAna. */
export const RETURNING_OWNER_TIMEOUT_MS = 1500;

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

/**
 * Ativação explícita: só herda quando `returning_customer_owner_enabled === true` nas configurações da organização.
 * A operação completa (configuração + consultas) tem limite de tempo; timeout ou erro → null (fluxo normal, sem dono).
 */
async function resolveInheritedOwnership(
  db: ReturnType<typeof getAdminClient>,
  organizationId: string,
  contactId: string,
): Promise<ReturningCustomerOwnership | null> {
  const outcome = await runWithTimeout(async (signal) => {
    const org = await getOrganizationById(db, organizationId);
    if ((org.settings as { returning_customer_owner_enabled?: boolean } | null)?.returning_customer_owner_enabled !== true) return null;
    return resolveReturningCustomerOwnership(createReturningCustomerDeps(db, signal), { organizationId, contactId });
  }, RETURNING_OWNER_TIMEOUT_MS);
  if (outcome.status === "ok") return outcome.value;
  if (outcome.status === "timeout") {
    console.warn(JSON.stringify({ event: "returning_owner_timeout", organizationId, contactId, timeoutMs: RETURNING_OWNER_TIMEOUT_MS }));
  } else {
    console.error("conversation: falha ao herdar responsável do cliente que voltou; criando sem dono", outcome.error);
  }
  return null;
}

export async function setHumanTakeover(conversationId: string, takeover: boolean) {
  const db = getAdminClient();
  return updateConversation(db, conversationId, {
    is_human_takeover: takeover,
    human_takeover_at: takeover ? new Date().toISOString() : null,
  });
}
