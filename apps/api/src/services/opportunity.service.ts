import type { SupabaseClient } from "@aula-agente/database";
import { createOpportunity, updateOpportunity, addOpportunityEvent } from "@aula-agente/database";
import { isValidStage, FUNNEL_STAGES } from "@aula-agente/shared";
import type { Opportunity, Operation, OpportunityEventActorType, Product, WaitingOn } from "@aula-agente/shared";

interface Actor {
  type: OpportunityEventActorType;
  id: string | null;
}

export async function changeStage(
  db: SupabaseClient,
  opportunityId: string,
  newStage: string,
  evidence: string,
  actor: Actor
): Promise<Opportunity> {
  const current = await db.from("opportunities").select("*").eq("id", opportunityId).single();
  if (current.error) throw current.error;
  const opportunity = current.data as Opportunity;

  if (!isValidStage(opportunity.operation, newStage)) {
    throw new Error(`Estágio "${newStage}" não existe no funil "${opportunity.operation}"`);
  }

  const updated = await updateOpportunity(db, opportunityId, {
    stage: newStage,
    last_progress_at: new Date().toISOString(),
  });

  await addOpportunityEvent(db, {
    organization_id: opportunity.organization_id,
    opportunity_id: opportunityId,
    event_type: "stage_changed",
    previous_value: { stage: opportunity.stage },
    new_value: { stage: newStage },
    evidence,
    changed_by_type: actor.type,
    changed_by_id: actor.id,
  });

  return updated;
}

export async function changeOperation(
  db: SupabaseClient,
  opportunityId: string,
  newOperation: Operation,
  evidence: string,
  actor: Actor
): Promise<Opportunity> {
  const current = await db.from("opportunities").select("*").eq("id", opportunityId).single();
  if (current.error) throw current.error;
  const opportunity = current.data as Opportunity;

  // Trocar de funil torna o estágio antigo inválido no funil novo — sempre
  // reinicia no primeiro estágio do funil de destino, nunca mantém o valor
  // antigo por engano.
  const newStage = FUNNEL_STAGES[newOperation][0];

  const updated = await updateOpportunity(db, opportunityId, {
    operation: newOperation,
    stage: newStage,
    last_progress_at: new Date().toISOString(),
  });

  await addOpportunityEvent(db, {
    organization_id: opportunity.organization_id,
    opportunity_id: opportunityId,
    event_type: "operation_changed",
    previous_value: { operation: opportunity.operation, stage: opportunity.stage },
    new_value: { operation: newOperation, stage: newStage },
    evidence,
    changed_by_type: actor.type,
    changed_by_id: actor.id,
  });

  return updated;
}

export async function markWon(
  db: SupabaseClient,
  opportunityId: string,
  evidence: string,
  actor: Actor
): Promise<Opportunity> {
  const current = await db.from("opportunities").select("*").eq("id", opportunityId).single();
  if (current.error) throw current.error;
  const opportunity = current.data as Opportunity;

  const updated = await updateOpportunity(db, opportunityId, {
    status: "won",
    last_progress_at: new Date().toISOString(),
  });

  await addOpportunityEvent(db, {
    organization_id: opportunity.organization_id,
    opportunity_id: opportunityId,
    event_type: "won",
    previous_value: { status: opportunity.status },
    new_value: { status: "won" },
    evidence,
    changed_by_type: actor.type,
    changed_by_id: actor.id,
  });

  return updated;
}

export async function markLost(
  db: SupabaseClient,
  opportunityId: string,
  evidence: string,
  lostReason: string,
  resumeDate: string | null,
  actor: Actor
): Promise<Opportunity> {
  const current = await db.from("opportunities").select("*").eq("id", opportunityId).single();
  if (current.error) throw current.error;
  const opportunity = current.data as Opportunity;

  const updated = await updateOpportunity(db, opportunityId, {
    status: "lost",
    lost_reason: lostReason,
    resume_date: resumeDate,
    last_progress_at: new Date().toISOString(),
  });

  await addOpportunityEvent(db, {
    organization_id: opportunity.organization_id,
    opportunity_id: opportunityId,
    event_type: "lost",
    previous_value: { status: opportunity.status },
    new_value: { status: "lost", lost_reason: lostReason, resume_date: resumeDate },
    evidence,
    changed_by_type: actor.type,
    changed_by_id: actor.id,
  });

  return updated;
}

export interface UpdateOpportunityFieldsInput {
  owner_id?: string | null;
  next_action?: string | null;
  next_action_due_date?: string | null;
  waiting_on?: WaitingOn | null;
  waiting_on_until?: string | null;
  product?: Product | null;
  product_model?: string | null;
  sale_amount?: number | null;
  credit_amount?: number | null;
  down_payment_amount?: number | null;
  bid_amount?: number | null;
  target_installment_amount?: number | null;
  term_months?: number | null;
  usage_purpose?: string | null;
  urgency?: string | null;
  main_objection?: string | null;
  commercial_notes?: string | null;
}

// Campos livres, sem exigência de evidência — só stage/operation/won/lost
// (mudanças de resultado comercial) exigem evidência, conforme a spec.
export async function updateOpportunityFields(
  db: SupabaseClient,
  opportunityId: string,
  updates: UpdateOpportunityFieldsInput
): Promise<Opportunity> {
  return updateOpportunity(db, opportunityId, updates);
}
