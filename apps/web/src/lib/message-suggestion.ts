import { defaultSuggestionMode, latestInstant, type MessageSuggestionMode } from "@aula-agente/shared";

/** O botão "Sugerir mensagem" só existe com a chave ligada, negócio aberto, detalhes carregados e conversa existente. */
export function canSuggestMessage(input: { enabled: boolean; status: string; detailsLoaded: boolean; hasConversation: boolean }): boolean {
  return input.enabled && input.status === "open" && input.detailsLoaded && input.hasConversation;
}

/** Modo inicial do painel a partir do que o card da lista já traz (última mensagem de humano, atribuição, encaminhamento da IA). */
export function initialSuggestionMode(card: { contact_state?: { lastHumanMessageAt?: string | null } | null; owner_assigned_at?: string | null; sales_state?: { handedAt?: string | null } | null }): MessageSuggestionMode {
  return defaultSuggestionMode({
    lastHumanMessageAt: card.contact_state?.lastHumanMessageAt,
    since: latestInstant(card.owner_assigned_at, card.sales_state?.handedAt),
  });
}

/** Mensagem clara por tipo de falha da rota; nunca texto de reserva. */
export function suggestionErrorMessage(err: { status?: number; message?: string } | null | undefined): string {
  if (err?.status === 429) return "Você atingiu o limite de sugestões por hora. Tente de novo mais tarde.";
  if (err?.status === 422 || err?.status === 409 || err?.status === 403 || err?.status === 404) return err.message || "Não foi possível gerar a sugestão para este negócio.";
  return "Não foi possível gerar. Tente de novo.";
}
