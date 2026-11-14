// Sincronização de "Aguardando" (waiting_on) e próxima ação SÓ quando a mudança de responsabilidade é comprovada.
// Funções puras. Regra de ouro: nunca tocar em valor que um humano editou — só nos valores automáticos conhecidos abaixo.
// Não vale: "toda mensagem do vendedor é proposta" nem "toda resposta transfere a pendência". Só estas duas transições:
//   1) equipe -> cliente: o humano CONCLUIU a tarefa de atendimento do repasse e já respondeu o cliente na conversa;
//   2) cliente -> equipe: o cliente respondeu de forma substantiva e o "Aguardando cliente" foi posto por esta regra.

/** Próxima ação gravada pelo repasse da IA (sync_sales_pipeline). Se ainda é este texto, ninguém a editou. */
export const HANDOFF_AUTO_NEXT_ACTION = "Atender cliente encaminhado pela IA";
export const AWAITING_CUSTOMER_NEXT_ACTION = "Aguardar resposta do cliente";
export const CUSTOMER_REPLIED_NEXT_ACTION = "Responder ao cliente";

/** Etapas em que a pendência é genuinamente da equipe/banco (simulação, análise, condições): nunca viram "cliente" sozinhas. */
export const TEAM_OWNED_STAGES = ["awaiting_simulation", "financing_rejected", "conditions_approved_negotiation", "bank_analysis"] as const;

interface OppFacts { status: string; stage: string; waiting_on: string | null; next_action: string | null }

export type AttendanceSyncDecision =
  | { action: "set_customer"; waiting_on: "customer"; next_action: string }
  | { action: "keep"; reason: "not_open" | "not_waiting_team" | "next_action_edited" | "team_owned_stage" | "not_attendance_task" | "no_human_reply" | "other_open_tasks" };

export function decideAttendanceCompleted(i: {
  opportunity: OppFacts;
  /** Tipos da tarefa concluída (o tipo dela + as pendências consolidadas). */
  completedTypes: string[];
  /** Há mensagem humana (human_agent) na conversa da tarefa DEPOIS de a tarefa ter sido criada. */
  humanRepliedAfterTaskCreated: boolean;
  /** Outras tarefas abertas do negócio (qualquer tipo): se existem, há obrigação em aberto e não se adivinha. */
  otherOpenTasks: number;
}): AttendanceSyncDecision {
  const keep = (reason: Extract<AttendanceSyncDecision, { action: "keep" }>["reason"]): AttendanceSyncDecision => ({ action: "keep", reason });
  const o = i.opportunity;
  if (o.status !== "open") return keep("not_open");
  if (o.waiting_on !== "team") return keep("not_waiting_team");
  if (o.next_action !== HANDOFF_AUTO_NEXT_ACTION) return keep("next_action_edited");
  if ((TEAM_OWNED_STAGES as readonly string[]).includes(o.stage)) return keep("team_owned_stage");
  if (!i.completedTypes.includes("return_customer")) return keep("not_attendance_task");
  if (!i.humanRepliedAfterTaskCreated) return keep("no_human_reply");
  if (i.otherOpenTasks > 0) return keep("other_open_tasks");
  return { action: "set_customer", waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION };
}

export type CustomerReplySyncDecision =
  | { action: "set_team"; waiting_on: "team"; next_action: string }
  | { action: "keep"; reason: "not_open" | "not_waiting_customer" | "not_auto_waiting" | "not_substantive" };

export function decideCustomerReplied(i: { opportunity: OppFacts; substantive: boolean }): CustomerReplySyncDecision {
  const o = i.opportunity;
  if (o.status !== "open") return { action: "keep", reason: "not_open" };
  if (o.waiting_on !== "customer") return { action: "keep", reason: "not_waiting_customer" };
  if (o.next_action !== AWAITING_CUSTOMER_NEXT_ACTION) return { action: "keep", reason: "not_auto_waiting" };
  if (!i.substantive) return { action: "keep", reason: "not_substantive" };
  return { action: "set_team", waiting_on: "team", next_action: CUSTOMER_REPLIED_NEXT_ACTION };
}
