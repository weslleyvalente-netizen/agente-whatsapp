import { getAdminClient } from "@aula-agente/database";
import { createMessage, messageExistsByEvolutionId } from "@aula-agente/database";
import { updateConversation } from "@aula-agente/database";
import type { MessageRole, MediaType } from "@aula-agente/shared";

interface SaveMessageParams {
  conversationId: string;
  organizationId: string;
  evolutionMessageId: string | null;
  role: MessageRole;
  content: string;
  mediaUrl?: string | null;
  mediaType?: MediaType | null;
  metadata?: Record<string, unknown> | null;
  // Só para mensagens recuperadas (replay): preserva o horário original em created_at.
  // Sem isto o banco usa now(), que é o comportamento normal.
  createdAt?: string;
}

export async function saveMessage(params: SaveMessageParams) {
  const db = getAdminClient();

  // Idempotency check
  if (params.evolutionMessageId) {
    const exists = await messageExistsByEvolutionId(db, params.evolutionMessageId);
    if (exists) {
      return null; // Already processed
    }
  }

  const message = await createMessage(db, {
    conversation_id: params.conversationId,
    organization_id: params.organizationId,
    evolution_message_id: params.evolutionMessageId,
    role: params.role,
    content: params.content,
    media_url: params.mediaUrl || null,
    media_type: params.mediaType || null,
    metadata: params.metadata || null,
    ...(params.createdAt ? { created_at: params.createdAt } : {}),
  });

  // Update conversation last_message_at
  await updateConversation(db, params.conversationId, {
    last_message_at: new Date().toISOString(),
  });

  return message;
}
