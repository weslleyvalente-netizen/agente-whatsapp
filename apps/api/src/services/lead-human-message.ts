import { isHumanOriginMessage } from "@aula-agente/shared";
import { recordHumanMessage, type SupabaseClient } from "@aula-agente/database";

interface Input {
  organizationId: string;
  conversationId: string;
  role: string;
  source: "panel" | "phone_echo";
  actorUserId?: string | null;
  metadata?: Record<string, unknown> | null;
  echoMatchedSystemMessage?: boolean;
  greetingFiltered?: boolean;
  at?: Date;
}

/** Marca a primeira resposta humana (e assume o lead quando cabe). Só origem humana comprovada conta. Nunca lança. */
export async function trackFirstHumanMessage(db: SupabaseClient, input: Input): Promise<string | null> {
  if (!isHumanOriginMessage(input)) return null;
  try {
    return await recordHumanMessage(db, {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      at: input.at ?? new Date(),
      authorUserId: input.source === "panel" ? input.actorUserId ?? null : null,
      via: input.source,
    });
  } catch (err) {
    console.error("Failed to record first human message for lead distribution:", err);
    return null;
  }
}
