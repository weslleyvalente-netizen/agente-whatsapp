import { z } from "zod";

export const MESSAGE_SUGGESTION_MODES = ["first_contact", "followup"] as const;
export type MessageSuggestionMode = (typeof MESSAGE_SUGGESTION_MODES)[number];
export const MESSAGE_SUGGESTION_MODE_LABELS: Record<MessageSuggestionMode, string> = { first_contact: "Primeiro atendimento", followup: "Follow-up" };

export const messageSuggestionBodySchema = z.object({
  mode: z.enum(MESSAGE_SUGGESTION_MODES).optional(),
  regenerate: z.boolean().optional(),
  previousMessage: z.string().trim().max(4000).optional(),
});

/**
 * Modo padrão pelo contexto: sem mensagem de humano (role=human_agent) depois do encaminhamento/atribuição → primeiro atendimento;
 * caso contrário → follow-up. `since` é o instante mais recente entre atribuição ao responsável e encaminhamento pela IA.
 */
export function defaultSuggestionMode(input: { lastHumanMessageAt?: string | null; since?: string | null }): MessageSuggestionMode {
  const last = input.lastHumanMessageAt ? Date.parse(input.lastHumanMessageAt) : NaN;
  if (!Number.isFinite(last)) return "first_contact";
  const since = input.since ? Date.parse(input.since) : NaN;
  return Number.isFinite(since) && last < since ? "first_contact" : "followup";
}

/** Instante mais recente entre as datas válidas (ISO), ou null. */
export function latestInstant(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) if (v && Number.isFinite(Date.parse(v)) && (!best || Date.parse(v) > Date.parse(best))) best = v;
  return best;
}

/** Quem falou, no vocabulário do vendedor: contact→cliente, human_agent→vendedora, agent→IA. */
export function suggestionRoleLabel(role: string): string {
  return role === "contact" ? "cliente" : role === "human_agent" ? "vendedora" : role === "agent" ? "IA" : role;
}

/** Mensagem "[audio]" sem transcrição não tem conteúdo conhecido: não deve ser interpretada pelo modelo. */
export function isUntranscribedMedia(content: string): boolean {
  return /^\[(audio|áudio|image|imagem|document|documento|video|vídeo|sticker)\]$/i.test(content.trim());
}
