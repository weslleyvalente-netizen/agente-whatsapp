"use client";

import { useState } from "react";
import { DndContext, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { apiFetch } from "@/lib/api";
import { FUNNEL_STAGES, FUNNEL_STAGE_LABELS } from "@aula-agente/shared";
import type { Opportunity, Operation } from "@aula-agente/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StageChangeDialog } from "@/components/opportunities/stage-change-dialog";

function OpportunityCard({ opportunity }: { opportunity: Opportunity }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: opportunity.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="cursor-grab mb-2">
      <Card>
        <CardContent className="p-3 text-sm space-y-1">
          <p className="font-medium">{opportunity.product_model || "Sem modelo"}</p>
          {opportunity.credit_amount != null && (
            <p className="text-muted-foreground">Crédito: R$ {opportunity.credit_amount}</p>
          )}
          {opportunity.sale_amount != null && (
            <p className="text-muted-foreground">Preço: R$ {opportunity.sale_amount}</p>
          )}
          {opportunity.next_action && (
            <p className="text-xs text-muted-foreground">
              Próxima ação: {opportunity.next_action}
              {opportunity.next_action_due_date && ` (${opportunity.next_action_due_date})`}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StageColumn({ stage, opportunities }: { stage: string; opportunities: Opportunity[] }) {
  const { setNodeRef } = useDroppable({ id: stage });
  return (
    <div ref={setNodeRef} className="w-64 shrink-0">
      <Card>
        <CardHeader className="p-3">
          <CardTitle className="text-sm">{FUNNEL_STAGE_LABELS[stage] ?? stage}</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {opportunities.map((o) => (
            <OpportunityCard key={o.id} opportunity={o} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function OpportunityKanban({
  operation,
  opportunities,
  onChanged,
}: {
  operation: Operation;
  opportunities: Opportunity[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<{ opportunity: Opportunity; targetStage: string } | null>(null);
  const stages = FUNNEL_STAGES[operation];

  function handleDragEnd(event: DragEndEvent) {
    const opportunityId = String(event.active.id);
    const targetStage = event.over?.id as string | undefined;
    if (!targetStage) return;

    const opportunity = opportunities.find((o) => o.id === opportunityId);
    if (!opportunity || opportunity.stage === targetStage) return;

    setPending({ opportunity, targetStage });
  }

  async function confirmStageChange(evidence: string) {
    if (!pending) return;
    await apiFetch(`/opportunities/${pending.opportunity.id}/stage`, {
      method: "POST",
      body: JSON.stringify({ stage: pending.targetStage, evidence }),
    });
    setPending(null);
    onChanged();
  }

  return (
    <>
      <DndContext onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto">
          {stages.map((stage) => (
            <StageColumn
              key={stage}
              stage={stage}
              opportunities={opportunities.filter((o) => o.stage === stage)}
            />
          ))}
        </div>
      </DndContext>
      {pending && (
        <StageChangeDialog
          open={!!pending}
          fromLabel={FUNNEL_STAGE_LABELS[pending.opportunity.stage] ?? pending.opportunity.stage}
          toLabel={FUNNEL_STAGE_LABELS[pending.targetStage] ?? pending.targetStage}
          onConfirm={confirmStageChange}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
