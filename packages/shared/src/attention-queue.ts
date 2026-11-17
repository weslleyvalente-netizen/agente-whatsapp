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
  /** Total da categoria na janela antes do limite do banco (igual em todas as linhas da categoria). Ausente em dados antigos. */
  kind_total?: number | string | null;
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

/**
 * `items`/`total`: casos de até 7 dias (mais antigo primeiro, no máximo `limit`).
 * `older`: casos com mais de 7 dias (mais antigo primeiro, no máximo ATTENTION_OLDER_LIMIT), para a seção recolhível.
 * Janela total continua a mesma (30 dias): total de comparação = `total + older.total`.
 */
export interface AttentionList { items: AttentionItem[]; total: number; older: { items: AttentionItem[]; total: number } }
export interface AttentionLists { awaiting: AttentionList; newLeads: AttentionList }
export interface AttentionQueue extends AttentionLists {
  /** Conversas e leads sem dono, só para quem tem permissão de ver (gestor). null para os demais. */
  unowned: AttentionLists | null;
}

/**
 * Piloto por usuário: a fila só liga para quem a organização liberou. Precisa da flag da organização E de o usuário estar em
 * `needs_reply_queue_user_ids`. Sem a lista (ou vazia) ninguém recebe: ligar só a flag não libera a organização inteira.
 * Mesma regra no backend (autoridade) e na tela (evita a chamada à toa).
 */
export function isNeedsReplyQueueEnabledFor(
  settings: { needs_reply_queue_enabled?: unknown; needs_reply_queue_user_ids?: unknown } | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (!settings || !userId || settings.needs_reply_queue_enabled !== true) return false;
  const ids = settings.needs_reply_queue_user_ids;
  return Array.isArray(ids) && ids.includes(userId);
}

/**
 * A lista veio cortada pelo limite do banco? Compara as linhas recebidas de cada categoria com `kind_total`.
 * Quando é true os contadores são "pelo menos" (e o banco devolve os casos mais antigos primeiro).
 */
export function isAttentionTruncated(candidates: Pick<AttentionCandidate, "kind" | "kind_total">[]): boolean {
  const received = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const c of candidates) {
    received.set(c.kind, (received.get(c.kind) ?? 0) + 1);
    const t = Number(c.kind_total);
    if (Number.isFinite(t)) totals.set(c.kind, Math.max(totals.get(c.kind) ?? 0, t));
  }
  for (const [kind, total] of totals) if ((received.get(kind) ?? 0) < total) return true;
  return false;
}

export const ATTENTION_LIST_LIMIT = 10;
/** Mais antigo que isso vai para a seção recolhível "Mais de 7 dias". */
export const ATTENTION_RECENT_DAYS = 7;
/** Quantos casos antigos a seção recolhível lista (o contador mostra o total). */
export const ATTENTION_OLDER_LIMIT = 50;

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
  const cutoffMin = ATTENTION_RECENT_DAYS * 24 * 60;
  const recent = sorted.filter((i) => i.waitingMinutes <= cutoffMin);
  const older = sorted.filter((i) => i.waitingMinutes > cutoffMin);
  return { items: recent.slice(0, limit), total: recent.length, older: { items: older.slice(0, ATTENTION_OLDER_LIMIT), total: older.length } };
}

/** Total da lista na janela inteira de 30 dias (até 7 dias + mais de 7 dias): é o número que a linha de base compara. */
export const attentionListTotal = (l: AttentionList): number => l.total + l.older.total;

/**
 * Monta as duas listas. Regras:
 *  - "Cliente aguardando resposta" tem prioridade: o mesmo cliente (contact_id) nunca aparece nas duas listas, nem duas vezes na mesma;
 *  - até 7 dias primeiro, do mais antigo para o mais recente; acima de 7 dias vão para `older` (seção recolhível), mesma ordem;
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
