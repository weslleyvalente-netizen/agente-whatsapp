import { isSubstantiveCustomerMessage } from "./sales-workspace.js";

/** Linha devolvida por public.attention_queue_candidates (somente leitura). */
export interface AttentionCandidate {
  kind: "awaiting" | "new_lead";
  conversation_id: string;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  owner_user_id: string | null;
  is_human_takeover: boolean;
  waiting_since: string;
  last_contact_at: string;
  /** Já existiu atendimento humano nesta conversa (antes das mensagens sem resposta). */
  had_human_reply: boolean;
  /** Mensagens do cliente sem resposta humana, da mais recente para a mais antiga (até 5). */
  unanswered_contents: string[] | null;
}

export type AttentionViewer = { mode: "all" } | { mode: "own"; userId: string };

export interface AttentionItem {
  conversationId: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  ownerUserId: string | null;
  waitingSince: string;
  waitingMinutes: number;
}

export interface AttentionList { items: AttentionItem[]; total: number }
export interface AttentionLists { awaiting: AttentionList; newLeads: AttentionList }
export interface AttentionQueue extends AttentionLists {
  /** Conversas e leads sem dono, só para quem tem permissão de ver (gestor). null para os demais. */
  unowned: AttentionLists | null;
}

export const ATTENTION_LIST_LIMIT = 10;

/**
 * Cliente aguardando resposta humana? Cortesia ("obrigado", "ok") DEPOIS de um atendimento não reabre a fila;
 * um pedido novo (pergunta, número, áudio, frase com conteúdo) reabre. Sem atendimento anterior, qualquer mensagem
 * sem resposta conta (o cliente nunca foi atendido). Regra de cortesia reaproveitada de isSubstantiveCustomerMessage.
 */
export function isAwaitingHumanReply(c: Pick<AttentionCandidate, "had_human_reply" | "unanswered_contents">): boolean {
  if (!c.had_human_reply) return true;
  const contents = c.unanswered_contents ?? [];
  if (contents.length === 0) return true; // sem texto para julgar: conta (conteúdo desconhecido é substantivo)
  return contents.some((text) => isSubstantiveCustomerMessage(text));
}

const toItem = (c: AttentionCandidate, nowMs: number): AttentionItem => ({
  conversationId: c.conversation_id,
  contactId: c.contact_id,
  contactName: c.contact_name,
  contactPhone: c.contact_phone ?? "",
  ownerUserId: c.owner_user_id,
  waitingSince: c.waiting_since,
  waitingMinutes: Math.max(0, Math.floor((nowMs - Date.parse(c.waiting_since)) / 60_000)),
});

const oldestFirst = (a: AttentionItem, b: AttentionItem) =>
  Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || a.conversationId.localeCompare(b.conversationId);

function toList(items: AttentionItem[], limit: number): AttentionList {
  const sorted = [...items].sort(oldestFirst);
  return { items: sorted.slice(0, limit), total: sorted.length };
}

/**
 * Monta as duas listas. Regras:
 *  - "Cliente aguardando resposta" tem prioridade: o mesmo cliente (contact_id) nunca aparece nas duas listas, nem duas vezes na mesma;
 *  - ordem do mais antigo para o mais recente em cada lista, com `waitingMinutes`;
 *  - vendedor (mode "own") só vê o que é dele; sem dono só vai para `unowned` e só para gestor (mode "all").
 */
export function buildAttentionQueue(
  candidates: AttentionCandidate[],
  opts: { viewer: AttentionViewer; now?: Date; limit?: number },
): AttentionQueue {
  const nowMs = (opts.now ?? new Date()).getTime();
  const limit = opts.limit ?? ATTENTION_LIST_LIMIT;
  const canSeeUnowned = opts.viewer.mode === "all";

  const owned: AttentionCandidate[] = [];
  const unowned: AttentionCandidate[] = [];
  for (const c of candidates) {
    if (c.kind === "awaiting" && !isAwaitingHumanReply(c)) continue;
    if (!c.owner_user_id) { if (canSeeUnowned) unowned.push(c); continue; }
    if (opts.viewer.mode === "own" && c.owner_user_id !== opts.viewer.userId) continue;
    owned.push(c);
  }

  const split = (rows: AttentionCandidate[]): AttentionLists => {
    // Por cliente: se há mensagem aguardando, ela vence o lead; entre iguais, a espera mais antiga.
    const byContact = new Map<string, AttentionCandidate>();
    for (const c of rows) {
      const prev = byContact.get(c.contact_id);
      if (!prev) { byContact.set(c.contact_id, c); continue; }
      const better = c.kind !== prev.kind ? c.kind === "awaiting" : Date.parse(c.waiting_since) < Date.parse(prev.waiting_since);
      if (better) byContact.set(c.contact_id, c);
    }
    const kept = [...byContact.values()];
    return {
      awaiting: toList(kept.filter((c) => c.kind === "awaiting").map((c) => toItem(c, nowMs)), limit),
      newLeads: toList(kept.filter((c) => c.kind === "new_lead").map((c) => toItem(c, nowMs)), limit),
    };
  };

  const lists = split(owned);
  return { ...lists, unowned: canSeeUnowned ? split(unowned) : null };
}

/** Formata "há 5 min", "há 3 h", "há 2 dias". */
export function formatWaiting(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "dia" : "dias"}`;
}
