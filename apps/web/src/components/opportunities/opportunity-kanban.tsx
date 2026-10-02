"use client";

import { useRef, useState } from "react";
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { apiFetch } from "@/lib/api";
import { FUNNEL_STAGES, FUNNEL_STAGE_LABELS, sortNewestSalesCards, sortSalesQueue, classifySalesQueue, SALES_QUEUE_LABELS, type SalesQueueGroup } from "@aula-agente/shared";
import type { Opportunity, Operation, SalesCardState } from "@aula-agente/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Pencil, Flame, UserCheck, MessageCircle, ListChecks } from "lucide-react";
import { StageChangeDialog } from "@/components/opportunities/stage-change-dialog";
import { OpportunityDetailDialog } from "./opportunity-detail-dialog";
import { OpportunityEditDialog } from "@/components/opportunities/opportunity-edit-dialog";

// Contact name/phone is embedded server-side (getOpportunitiesByOrganization
// joins wa_contacts) — the type from @aula-agente/shared is the bare table
// row, so the joined shape is declared once here rather than widening the
// shared domain type for a display-only concern.
export type OpportunityWithContact = Opportunity & {
  sales_state?: SalesCardState;
  wa_contacts: { name: string | null; phone: string } | null;
};

function OpportunityCard({
  opportunity,
  onEdit,
  onOpen,
}: {
  opportunity: OpportunityWithContact;
  onEdit: (opportunity: OpportunityWithContact) => void;
  onOpen: (opportunity: OpportunityWithContact) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: opportunity.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  const contactLabel = opportunity.wa_contacts?.name || opportunity.wa_contacts?.phone || "Contato desconhecido";

  return (
    <div className="mb-2">
      <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="cursor-grab" onClick={() => !isDragging && onOpen(opportunity)} onKeyUp={e => { if (e.key === "Enter") onOpen(opportunity); }}>
        <Card>
          <CardContent className="p-3 text-sm space-y-1">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{contactLabel}</p>
              <button
                type="button"
                aria-label="Editar oportunidade"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onEdit(opportunity); }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
            {opportunity.frozen_until && <p className="text-xs text-blue-600">Retorno combinado: {new Date(`${opportunity.frozen_until}T12:00:00`).toLocaleDateString("pt-BR")}</p>}
            {opportunity.sales_state && <div className="flex flex-wrap gap-2 text-xs">
              {opportunity.sales_state.hot && <span title="Intenção de fechamento ou negociação" className="flex items-center gap-1 text-orange-600"><Flame className="size-3.5"/>Quente</span>}
              {opportunity.sales_state.humanPending && <span className="flex items-center gap-1 text-primary"><UserCheck className="size-3.5"/>Atendimento pendente</span>}
              {opportunity.sales_state.customerReplied && <span title="A última mensagem da conversa é do cliente" className="flex items-center gap-1"><MessageCircle className="size-3.5"/>Cliente respondeu</span>}
              {opportunity.sales_state.taskCount > 0 && <span className="flex items-center gap-1"><ListChecks className="size-3.5"/>{opportunity.sales_state.taskCount} tarefa(s)</span>}
            </div>}
            <p className="text-xs text-muted-foreground">Criado em {new Date(opportunity.created_at).toLocaleDateString("pt-BR")}</p>
            {opportunity.sales_state?.readyForHuman && <p className="text-xs text-muted-foreground">Etapa comercial: {FUNNEL_STAGE_LABELS[opportunity.stage] ?? opportunity.stage}</p>}
            {opportunity.product_model && (
              <p className="text-muted-foreground">{opportunity.product_model}</p>
            )}
            {opportunity.credit_amount != null && (
              <p className="text-muted-foreground">
                {/* PostgREST returns Postgres `numeric` columns as strings to avoid
                    precision loss, despite the TS type saying `number` — wrap in
                    Number() so .toLocaleString() never crashes on a string value. */}
                Crédito: R${" "}
                {Number(opportunity.credit_amount).toLocaleString("pt-BR", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
            )}
            {opportunity.sale_amount != null && (
              <p className="text-muted-foreground">
                Preço: R${" "}
                {Number(opportunity.sale_amount).toLocaleString("pt-BR", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
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
  onOpen,
  queueMode = false,
}: {
  queueMode?: boolean;
  stage: string;
  opportunities: OpportunityWithContact[];
  onEdit: (opportunity: OpportunityWithContact) => void;
  onOpen: (opportunity: OpportunityWithContact) => void;
}) {
  const { setNodeRef } = useDroppable({ id: stage });
  return (
    <div ref={setNodeRef} className="w-64 shrink-0">
      <Card>
        <CardHeader className="p-3">
          <CardTitle className="text-sm">{stage.startsWith("__queue_") ? SALES_QUEUE_LABELS[stage.slice(8) as SalesQueueGroup] : stage === "__ready_for_marina" ? "Pronto para Marina" : FUNNEL_STAGE_LABELS[stage] ?? stage} <span className="text-muted-foreground">({opportunities.length})</span></CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {(queueMode ? sortSalesQueue(opportunities.map(o=>({...o,tasks:o.sales_state?.tasks})),new Date().toISOString()) : sortNewestSalesCards(opportunities)).map((o) => (
            <OpportunityCard key={o.id} opportunity={o} onEdit={onEdit} onOpen={onOpen} />
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
  workspaceEnabled = false,
  queueMode = false,
}: {
  operation: Operation;
  opportunities: OpportunityWithContact[];
  onChanged: () => void;
  workspaceEnabled?: boolean;
  queueMode?: boolean;
}) {
  const [pending, setPending] = useState<{ opportunity: OpportunityWithContact; targetStage: string } | null>(null);
  const [editing, setEditing] = useState<OpportunityWithContact | null>(null);
  const [selected, setSelected] = useState<OpportunityWithContact | null>(null);
  const draggedAt = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor));
  const stages = queueMode ? Object.keys(SALES_QUEUE_LABELS).map(k=>`__queue_${k}`) : [...(workspaceEnabled ? ["__ready_for_marina"] : []), ...FUNNEL_STAGES[operation]];

  function handleDragEnd(event: DragEndEvent) {
    draggedAt.current = Date.now();
    const opportunityId = String(event.active.id);
    const targetStage = event.over?.id as string | undefined;
    if (!targetStage || targetStage.startsWith("__")) return;

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
      <DndContext sensors={sensors} onDragStart={() => { draggedAt.current = Date.now(); }} onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto">
          {stages.map((stage) => (
            <StageColumn
              key={stage}
              stage={stage}
              queueMode={queueMode}
              opportunities={opportunities.filter((o) => queueMode ? stage === `__queue_${classifySalesQueue({...o,tasks:o.sales_state?.tasks},new Date().toISOString()).group}` : stage === "__ready_for_marina" ? o.sales_state?.readyForHuman : o.stage === stage && !o.sales_state?.readyForHuman)}
              onEdit={setEditing}
              onOpen={o => { if (Date.now() - draggedAt.current > 400) setSelected(o); }}
            />
          ))}
        </div>
      </DndContext>
      {selected && <OpportunityDetailDialog opportunity={opportunities.find(o => o.id === selected.id) ?? selected} onClose={() => setSelected(null)} onChanged={onChanged}/>}
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
            onChanged();
          }}
        />
      )}
    </>
  );
}
