import { HANDOFF_TRIGGER_TYPES, HANDOFF_MOTIVOS, HANDOFF_URGENCIAS } from "../constants.js";

export type HandoffTriggerType = (typeof HANDOFF_TRIGGER_TYPES)[number];
export type HandoffMotivo = (typeof HANDOFF_MOTIVOS)[number];
export type HandoffUrgencia = (typeof HANDOFF_URGENCIAS)[number];
export type HandoffActorType = "ia" | "humano" | "sistema";

// One row per takeover-affecting event, regardless of how it started —
// trigger_type is the discriminator. motivo/resumo/urgencia only ever come
// from the requestHuman tool (trigger_type = "request_human"); every other
// trigger_type leaves them null. fromMe_greeting_filtered rows represent a
// takeover that did NOT happen (see isGreetingOrShortConfirmation) — they
// exist purely to measure how often a would-be takeover was avoided, so
// first_human_reply_at never applies to them.
export interface HandoffEvent {
  id: string;
  organization_id: string;
  conversation_id: string;
  trigger_type: HandoffTriggerType;
  motivo: HandoffMotivo | null;
  resumo: string | null;
  urgencia: HandoffUrgencia | null;
  criado_por: HandoffActorType;
  handed_at: string;
  first_human_reply_at: string | null;
  created_at: string;
}
