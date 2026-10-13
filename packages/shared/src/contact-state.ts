/** Último contato humano com o cliente (mensagem de atendente ou ligação registrada) e se ele ocorreu depois de o negócio chegar ao responsável atual. */
export interface ContactState {
  lastHumanMessageAt: string | null;
  lastCallAt: string | null;
  lastContactAt: string | null;
  contactedSinceAssigned: boolean;
}

const later = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : a ?? b);

export function computeContactState(input: { ownerAssignedAt?: string | null; lastHumanMessageAt?: string | null; lastCallAt?: string | null }): ContactState {
  const lastHumanMessageAt = input.lastHumanMessageAt ?? null;
  const lastCallAt = input.lastCallAt ?? null;
  const lastContactAt = later(lastHumanMessageAt, lastCallAt);
  const assigned = input.ownerAssignedAt ?? null;
  return { lastHumanMessageAt, lastCallAt, lastContactAt, contactedSinceAssigned: !!lastContactAt && (!assigned || lastContactAt >= assigned) };
}

/** Texto curto para o selo do card. `now` e as datas em ISO; o dia é o de Brasília. */
export function contactBadgeLabel(state: ContactState | undefined | null, now: string): { text: string; tone: "ok" | "warn" | "none" } {
  if (!state?.lastContactAt) return { text: "Sem contato", tone: "none" };
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const days = Math.round((Date.parse(day(now)) - Date.parse(day(state.lastContactAt))) / 86400000);
  const label = days <= 0 ? "Contatado hoje" : days === 1 ? "Último contato: ontem" : `Último contato: há ${days} dias`;
  return { text: label, tone: state.contactedSinceAssigned ? (days <= 2 ? "ok" : "warn") : "none" };
}
