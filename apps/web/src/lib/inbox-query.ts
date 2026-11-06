// Funções puras da caixa de conversas: filtros por aba, texto de busca,
// paginação e mesclagem do refresh em tempo real. A página só orquestra.

export type InboxTab = "all" | "mine" | "agent" | "others" | "attention";

export const PAGE_SIZE = 50;

export type TabFilter =
  | { kind: "none" }
  | { kind: "nothing" }
  | { kind: "assigned_to_me"; userId: string }
  | { kind: "assigned_to_me_or_unassigned"; userId: string }
  | { kind: "ai_handling" }
  | { kind: "assigned_to_others"; userId: string }
  | { kind: "attention" };

export function tabFilter(
  tab: InboxTab,
  ctx: { userId: string | null; distributionOn: boolean; role: string | null },
): TabFilter {
  switch (tab) {
    case "mine":
      if (ctx.userId === null) return { kind: "nothing" };
      if (ctx.distributionOn && ctx.role === "agent") {
        return { kind: "assigned_to_me_or_unassigned", userId: ctx.userId };
      }
      return { kind: "assigned_to_me", userId: ctx.userId };
    case "agent":
      return { kind: "ai_handling" };
    case "others":
      if (ctx.userId === null) return { kind: "nothing" };
      return { kind: "assigned_to_others", userId: ctx.userId };
    case "attention":
      return { kind: "attention" };
    default:
      return { kind: "none" };
  }
}

/** Remove o que quebraria o filtro `or(...)` do PostgREST. */
function escapeLike(raw: string): string {
  return raw.replace(/[%,()"\\*]/g, "").trim();
}

export function searchTerms(raw: string): { text: string; digits: string | null } | null {
  const text = escapeLike(raw);
  if (!text) return null;
  // Só parece telefone se tiver dígitos e nada além de máscara (+ ( ) - espaço).
  const looksLikePhone = /^[\d\s+\-()]+$/.test(raw.trim()) && /\d/.test(raw);
  const digits = looksLikePhone ? raw.replace(/\D/g, "") : null;
  return { text, digits: digits || null };
}

/** Valor para `.or(..., { referencedTable: "wa_contacts" })`; null = sem busca. */
export function buildSearchOr(raw: string): string | null {
  const t = searchTerms(raw);
  if (!t) return null;
  const parts = [`name.ilike.%${t.text}%`];
  if (t.digits) parts.push(`phone.ilike.%${t.digits}%`);
  return parts.join(",");
}

export function pageRange(page: number): { from: number; to: number } {
  return { from: page * PAGE_SIZE, to: (page + 1) * PAGE_SIZE - 1 };
}

export function hasMore(receivedCount: number): boolean {
  return receivedCount >= PAGE_SIZE;
}

type Mergeable = { id: string; last_message_at: string };

/**
 * Mescla a primeira página recém-buscada com as páginas já carregadas:
 * substitui pelo id, mantém as mais antigas e reordena por last_message_at desc
 * (desempate por id desc, igual à consulta).
 */
export function mergeFirstPage<T extends Mergeable>(loaded: T[], fresh: T[]): T[] {
  const byId = new Map<string, T>();
  for (const c of loaded) byId.set(c.id, c);
  for (const c of fresh) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => {
    if (a.last_message_at !== b.last_message_at) return a.last_message_at < b.last_message_at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
