/** Deep link do funil: abre o card do cliente (e o chat ao lado) em /opportunities, sem passar por /inbox. */
export function funnelConversationHref(conversationId: string): string {
  return `/opportunities?conversa=${encodeURIComponent(conversationId)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valor do parâmetro `conversa` só quando é um UUID; qualquer outra coisa é ignorada. */
export function parseFunnelConversationParam(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && UUID.test(v) ? v : null;
}

export interface FunnelPickable { id: string; ownerId: string | null; lastInteractionAt: string | null }

/**
 * Vários negócios abertos no mesmo contato: escolhe um só — prefere o que tem dono e, entre eles, o de interação
 * mais recente (mesma regra do Cutucar cliente). Lista vazia = null.
 */
export function pickFunnelOpportunity<T extends FunnelPickable>(list: readonly T[]): T | null {
  if (!list.length) return null;
  return [...list].sort((a, b) => (a.ownerId ? 0 : 1) - (b.ownerId ? 0 : 1) || (b.lastInteractionAt ?? "").localeCompare(a.lastInteractionAt ?? "") || a.id.localeCompare(b.id))[0];
}
