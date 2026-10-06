// Retires AI-created "customer stopped replying" tasks that no longer need a
// human: we already reached out, the customer has been silent for days and the
// deal never got past the first stages. Anything with a commitment, a pending
// handoff, a human touch or an advanced deal is preserved. Conversations and
// deals stay open: a new customer message simply restarts the normal flow.
export const DEFAULT_SILENCE_RETIRE_DAYS = 7;
export const MIN_SILENCE_RETIRE_DAYS = 3;
const EARLY_STAGES = ["interest_received", "qualification"];

export interface SilenceRetirementInput {
 task: {status: string; type: string; created_by_type: string; followup_pending_message_id?: string | null; freeze_opportunity_id?: string | null; consolidated_pendencies?: Array<{type: string; freeze_opportunity_id?: string}>};
 /** Other open tasks of the same contact: any of them means a human is already tracking something. */
 otherOpenTasks: number;
 lastCustomerMessageAt: string | null;
 /** An agent/human message was sent after the customer's last message (we did reach out). */
 reachedOutAfterCustomer: boolean;
 /** A human (not the AI) wrote to this contact after the customer's last message. */
 humanTouchAfterCustomer: boolean;
 hasPendingHandoff: boolean;
 isHumanTakeover: boolean;
 openOpportunities: Array<{stage: string; frozen_until?: string | null; waiting_on?: string | null; next_action_due_date?: string | null}>;
 now: string;
 days?: number;
}

export function decideSilenceRetirement(input: SilenceRetirementInput): {retire: boolean; reason: string} {
 const no = (reason: string) => ({retire: false, reason});
 const days = Math.max(MIN_SILENCE_RETIRE_DAYS, input.days ?? DEFAULT_SILENCE_RETIRE_DAYS);
 const t = input.task;
 if (!['pending', 'in_progress', 'rescheduled'].includes(t.status)) return no('tarefa não está aberta');
 if (t.type !== 'customer_unresponsive' || t.created_by_type !== 'ai') return no('não é tarefa automática de silêncio');
 if (t.followup_pending_message_id || t.freeze_opportunity_id) return no('há envio ou congelamento pendente');
 if ((t.consolidated_pendencies ?? []).some(p => p.type !== 'customer_unresponsive' || p.freeze_opportunity_id)) return no('há pendência consolidada de outro tipo');
 if (input.otherOpenTasks > 0) return no('o contato tem outra tarefa aberta');
 if (input.hasPendingHandoff || input.isHumanTakeover) return no('atendimento humano em andamento');
 if (input.humanTouchAfterCustomer) return no('houve atendimento humano depois da última mensagem do cliente');
 if (!input.reachedOutAfterCustomer) return no('ainda não houve tentativa de contato');
 const last = Date.parse(input.lastCustomerMessageAt ?? '');
 if (!Number.isFinite(last)) return no('sem mensagem do cliente para medir o silêncio');
 if (Date.parse(input.now) - last < days * 86_400_000) return no('silêncio ainda recente');
 const today = input.now.slice(0, 10);
 for (const o of input.openOpportunities) {
  if (!EARLY_STAGES.includes(o.stage)) return no('negócio já avançou');
  if (o.frozen_until || o.waiting_on === 'scheduled_date' || o.waiting_on === 'bank_or_admin' || o.waiting_on === 'team') return no('negócio aguarda retorno combinado ou equipe');
  if (o.next_action_due_date && o.next_action_due_date >= today) return no('há ação combinada no negócio');
 }
 return {retire: true, reason: `Sem resposta do cliente há mais de ${days} dias, após tentativa de contato; negócio sem avanço e sem pendências.`};
}
