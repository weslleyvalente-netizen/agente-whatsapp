"use client";

import { useState } from "react";
import { DndContext, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { apiFetch } from "@/lib/api";
import { FUNNEL_STAGES, FUNNEL_STAGE_LABELS } from "@aula-agente/shared";
import type { Opportunity, Operation } from "@aula-agente/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";
import { StageChangeDialog } from "@/components/opportunities/stage-change-dialog";
import { OpportunityEditDialog } from "@/components/opportunities/opportunity-edit-dialog";

// Contact name/phone is embedded server-side (getOpportunitiesByOrganization
// joins wa_contacts) — the type from @aula-agente/shared is the bare table
// row, so the joined shape is declared once here rather than widening the
// shared domain type for a display-only concern.
export type OpportunityWithContact = Opportunity & {
  wa_contacts: { name: string | null; phone: string } | null;
};

function OpportunityCard({
  opportunity,
  onEdit,
}: {
  opportunity: OpportunityWithContact;
  onEdit: (opportunity: OpportunityWithContact) => void;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: opportunity.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  const contactLabel = opportunity.wa_contacts?.name || opportunity.wa_contacts?.phone || "Contato desconhecido";

  return (
    <div className="mb-2">
      <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="cursor-grab">
        <Card>
          <CardContent className="p-3 text-sm space-y-1">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{contactLabel}</p>
              <button
                type="button"
                aria-label="Editar oportunidade"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onEdit(opportunity)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
            {opportunity.product_model && (
              <p className="text-muted-foreground">{opportunity.product_model}</p>
            )}
            {opportunity.credit_amount != null && (
              <p className="text-muted-foreground">
                {/* PostgREST returns Postgres `numeric` columns as strings to avoid
                    precision loss, despite the TS type saying `number` — wrap in
                    Number() so .toLocaleString() never crashes on a string value. */}
                Crédito: R${" "}
                {Number(opportunity.credit_amount).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
              </p>
            )}
            {opportunity.sale_amount != null && (
              <p className="text-muted-foreground">
                Preço: R$ {Number(opportunity.sale_amount).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
              </p>
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
    </div>
  );
}

function StageColumn({
  stage,
  opportunities,
  onEdit,
}: {
  stage: string;
  opportunities: OpportunityWithContact[];
  onEdit: (opportunity: OpportunityWithContact) => void;
}) {
  const { setNodeRef } = useDroppable({ id: stage });
  return (
    <div ref={setNodeRef} className="w-64 shrink-0">
      <Card>
        <CardHeader className="p-3">
          <CardTitle className="text-sm">{FUNNEL_STAGE_LABELS[stage] ?? stage}</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {opportunities.map((o) => (
            <OpportunityCard key={o.id} opportunity={o} onEdit={onEdit} />
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
  opportunities: OpportunityWithContact[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<{ opportunity: OpportunityWithContact; targetStage: string } | null>(null);
  const [editing, setEditing] = useState<OpportunityWithContact | null>(null);
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
              onEdit={setEditing}
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
      {editing && (
        <OpportunityEditDialog
          opportunity={editing}
          open={!!editing}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
