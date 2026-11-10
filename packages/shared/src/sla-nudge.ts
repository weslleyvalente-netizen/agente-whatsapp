import type { LeadAssignment } from "./lead-distribution.js";

/** Alerta de SLA da carteira como o painel do gestor o recebe: a atribuição mais o cliente (null se o contato não foi achado). */
export interface SlaAlert extends LeadAssignment {
  contact_name: string | null;
  contact_phone: string | null;
}

/** Janela mínima entre dois toques ("Cutucar") para a mesma atribuição / o mesmo vendedor. */
export const SLA_NUDGE_COOLDOWN_MINUTES = 120;

/** Duração em português: "menos de 1 min", "5 min", "2 h", "1 dia", "3 dias". */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 dia" : `${days} dias`;
}

/** "venceu há 2 h" a partir do prazo (ou, sem prazo, da atribuição). */
export function overdueLabel(dueAt: string | null | undefined, now: Date = new Date()): string {
  const due = dueAt ? Date.parse(dueAt) : NaN;
  if (Number.isNaN(due)) return "prazo vencido";
  return `venceu há ${formatElapsed(now.getTime() - due)}`;
}

/** Nome do cliente; sem nome, o telefone; telefone @lid (identificador do WhatsApp, não é número) vira "Contato sem telefone". */
export function contactDisplayName(name: string | null | undefined, phone: string | null | undefined): string {
  const n = name?.trim();
  if (n) return n;
  const p = phone?.trim();
  if (!p || p.endsWith("@lid")) return "Contato sem telefone";
  return p;
}
