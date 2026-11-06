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

/**
 * Remove o que quebraria o filtro `or(...)` do PostgREST e escapa `_`
 * (curinga de um caractere no LIKE) com barra invertida.
 */
function escapeLike(raw: string): string {
  return raw.replace(/[%,()"\\*]/g, "").trim().replace(/_/g, "\\_");
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

/** Faixa para "Carregar mais": começa exatamente em quantas linhas já estão na tela. */
export function loadMoreRange(loadedCount: number): { from: number; to: number } {
  return { from: loadedCount, to: loadedCount + PAGE_SIZE - 1 };
}

/** Máximo de linhas que o refresh em tempo real rebusca (custo limitado). */
export const REFRESH_WINDOW_CAP = 300;

/** Janela do refresh em tempo real: o que já foi carregado (1 página a 300 linhas). */
export function windowRange(loadedCount: number): { from: number; to: number; size: number } {
  const size = Math.min(Math.max(PAGE_SIZE, loadedCount), REFRESH_WINDOW_CAP);
  return { from: 0, to: size - 1, size };
}

/** Há mais páginas se a resposta veio cheia em relação ao que foi pedido. */
export function hasMore(receivedCount: number, requested: number = PAGE_SIZE): boolean {
  return receivedCount >= requested;
}

/** Acrescenta uma página ao fim, sem duplicar ids (a ordem do servidor é mantida). */
export function appendPage<T extends { id: string }>(loaded: T[], page: T[]): T[] {
  const seen = new Set(loaded.map((c) => c.id));
  return [...loaded, ...page.filter((c) => !seen.has(c.id))];
}

/**
 * Aplica o resultado do refresh: substitui a janela (cabeça) pelo que o
 * servidor devolveu e MANTÉM as linhas já carregadas além da janela (podem
 * ficar um pouco desatualizadas), sem duplicar ids. `more` só é recalculado
 * quando a janela cobre tudo o que estava carregado; senão preserva o anterior.
 */
export function applyRefresh<T extends Mergeable>(
  loaded: T[],
  fresh: T[],
  prevHasMore: boolean,
): { list: T[]; more: boolean } {
  const { size } = windowRange(loaded.length);
  if (loaded.length <= size) return { list: appendPage([], fresh), more: hasMore(fresh.length, size) };
  // Janela menor que o pedido: o servidor não tem mais nada além dela.
  if (fresh.length < size) return { list: appendPage([], fresh), more: false };
  // Cauda = toda linha antiga que NÃO está em `fresh` e vem DEPOIS da última de
  // `fresh` na ordem da consulta. Assim, linhas empurradas para fora da janela
  // por conversas novas no topo não se perdem, e as que subiram para a cabeça
  // aparecem uma vez só. Offset do "carregar mais" = total: o servidor deslocou
  // para baixo pelas novas, então só há sobreposição (deduplicada), nunca salto.
  const last = fresh[fresh.length - 1];
  const inFresh = new Set(fresh.map((c) => c.id));
  const tail = loaded.filter((c) => !inFresh.has(c.id) && compareRows(c, last) > 0);
  return { list: [...fresh, ...tail], more: prevHasMore };
}

/** Marca qual carga inicial é a mais recente (quem resolve o `loading`). */
export function createLoadTracker() {
  let latest = 0;
  return {
    start: () => ++latest,
    isLatest: (id: number) => id === latest,
  };
}

/**
 * Geração: toda escrita na lista (troca de aba/busca, refresh, carregar mais)
 * só vale se foi calculada na geração atual; ao valer, a geração avança e
 * descarta qualquer outra resposta que estava em voo.
 */
export function createGeneration() {
  let current = 0;
  return {
    begin: () => current,
    /** Invalida tudo que está em voo (ex.: trocou de aba). */
    reset: () => ++current,
    /** true (e avança) se `token` ainda é a geração atual. */
    commit: (token: number) => {
      if (token !== current) return false;
      current++;
      return true;
    },
  };
}

/**
 * Limita a frequência: o primeiro evento agenda a execução em `wait` ms e os
 * seguintes NÃO reiniciam o relógio, então eventos contínuos ainda disparam.
 */
export function createThrottle(
  fn: () => void,
  wait: number,
  timers: {
    set: (cb: () => void, ms: number) => unknown;
    clear: (id: unknown) => void;
  } = { set: (cb, ms) => setTimeout(cb, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
) {
  let pending: unknown = null;
  return {
    trigger() {
      if (pending !== null) return;
      pending = timers.set(() => {
        pending = null;
        fn();
      }, wait);
    },
    cancel() {
      if (pending !== null) timers.clear(pending);
      pending = null;
    },
  };
}

type Mergeable = { id: string; last_message_at: string };

/** Ordem da consulta: last_message_at desc, id desc. Negativo = `a` vem antes de `b`. */
function compareRows(a: Mergeable, b: Mergeable): number {
  if (a.last_message_at !== b.last_message_at) return a.last_message_at < b.last_message_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Mescla a primeira página recém-buscada com as páginas já carregadas:
 * substitui pelo id, mantém as mais antigas e reordena por last_message_at desc
 * (desempate por id desc, igual à consulta).
 */
export function mergeFirstPage<T extends Mergeable>(loaded: T[], fresh: T[]): T[] {
  const byId = new Map<string, T>();
  for (const c of loaded) byId.set(c.id, c);
  for (const c of fresh) byId.set(c.id, c);
  return [...byId.values()].sort(compareRows);
}

/**
 * Aba "Atenção": o PostgREST não faz OR entre coluna da conversa e coluna do
 * contato, então a página roda duas consultas (cada uma limitada a
 * ATENCAO_CAP linhas) e mescla aqui. Sem paginação nessa aba. Se o conjunto
 * crescer além do limite, o futuro é uma view/RPC no banco.
 */
export const ATTENTION_CAP = 300;

export function mergeAttention<T extends Mergeable>(a: T[], b: T[], cap: number = ATTENTION_CAP): T[] {
  return mergeFirstPage(a, b).slice(0, cap);
}
