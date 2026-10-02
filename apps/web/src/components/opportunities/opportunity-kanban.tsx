"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { apiFetch } from "@/lib/api";
import { FUNNEL_STAGES, FUNNEL_STAGE_LABELS, OPERATION_LABELS, sortNewestSalesCards, sortSalesQueue, classifySalesQueue, SALES_QUEUE_LABELS, type SalesQueueGroup } from "@aula-agente/shared";
import type { Opportunity, Operation, SalesCardState } from "@aula-agente/shared";
import { Pencil, Flame, UserCheck, MessageCircle, ListChecks, CalendarDays, Bike, Snowflake, Clock3 } from "lucide-react";
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
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: opportunity.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}
      className={`cursor-grab rounded-2xl border bg-card p-4 text-sm shadow-sm transition-colors hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-primary ${isDragging ? "opacity-30" : ""} ${opportunity.sales_state?.hot ? "border-orange-300" : "border-border"}`}
      onClick={() => !isDragging && onOpen(opportunity)}
      onKeyUp={e => { if (e.key === "Enter" && e.target === e.currentTarget && !isDragging) onOpen(opportunity); }}>
      <OpportunityCardContent opportunity={opportunity} onEdit={onEdit}/>
    </div>
  );
}

// The overlay uses the same presentation without registering a second draggable.
function OpportunityCardContent({ opportunity, onEdit }: {
  opportunity: OpportunityWithContact;
  onEdit?: (opportunity: OpportunityWithContact) => void;
}) {
  const contactLabel = opportunity.wa_contacts?.name || opportunity.wa_contacts?.phone || "Contato desconhecido";

  const amount = opportunity.sale_amount ?? opportunity.credit_amount;
  const date = opportunity.frozen_until ?? opportunity.next_action_due_date;
  const interaction = opportunity.last_interaction_at && new Date(opportunity.last_interaction_at).getTime();
  const minutes = interaction && Number.isFinite(interaction) ? Math.max(0, Math.floor((Date.now() - interaction) / 60000)) : null;
  const elapsed = minutes === null ? null : minutes < 1 ? "agora" : minutes < 60 ? `há ${minutes} min` : minutes < 1440 ? `há ${Math.floor(minutes / 60)} h` : `há ${Math.floor(minutes / 1440)} dias`;
  const initials = contactLabel.split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join("").toUpperCase();
  return (
    <>
      {opportunity.sales_state?.hot && <span title="Intenção de fechamento ou negociação" className="mb-3 inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-1 text-xs text-orange-700"><Flame className="size-3.5"/>Quente</span>}
      <div className="flex items-start gap-2">
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">{initials}</span>
        <p className="min-w-0 flex-1 break-words font-semibold leading-7">{contactLabel}</p>
        {onEdit && <button type="button" aria-label="Editar oportunidade" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onEdit(opportunity); }}><Pencil className="size-3.5"/></button>}
      </div>
      {amount != null && <p className="mt-2 font-semibold tabular-nums"><span className="mr-2 text-xs font-normal text-muted-foreground">{opportunity.sale_amount != null ? "Preço" : "Crédito"}</span>{Number(amount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</p>}
      {opportunity.sale_amount != null && opportunity.credit_amount != null && <p className="mt-1 text-xs text-muted-foreground">Crédito: {Number(opportunity.credit_amount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</p>}
      <div className="mt-3 flex items-start gap-2 text-muted-foreground"><Bike className="mt-0.5 size-4 shrink-0"/><p className="line-clamp-2">{opportunity.product_model || opportunity.product || OPERATION_LABELS[opportunity.operation]}</p></div>
      <div className="mt-3 flex items-center gap-2 text-muted-foreground">{opportunity.frozen_until ? <Snowflake className="size-4"/> : <CalendarDays className="size-4"/>}<span>{date ? `${opportunity.frozen_until ? "Retorno: " : ""}${new Date(`${date}T12:00:00`).toLocaleDateString("pt-BR")}` : "Data a definir"}</span></div>
      {opportunity.next_action && <p className="mt-3 line-clamp-2 text-xs leading-relaxed" title={opportunity.next_action}>Próxima ação: {opportunity.next_action}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {opportunity.sales_state?.humanPending && <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-primary"><UserCheck className="size-3.5"/>Atendimento pendente</span>}
        {opportunity.sales_state?.customerReplied && <span title="A última mensagem da conversa é do cliente; pode ser uma resposta antiga" className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"><MessageCircle className="size-3.5"/>Cliente respondeu</span>}
        {!!opportunity.sales_state?.taskCount && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"><ListChecks className="size-3.5"/>{opportunity.sales_state.taskCount} {opportunity.sales_state.taskCount === 1 ? "tarefa" : "tarefas"}</span>}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="size-3.5 shrink-0"/>{elapsed ? `Última interação ${elapsed}` : `Criado em ${new Date(opportunity.created_at).toLocaleDateString("pt-BR")}`}</p>
      {opportunity.sales_state?.readyForHuman && <p className="mt-2 text-xs text-muted-foreground">Etapa comercial: {FUNNEL_STAGE_LABELS[opportunity.stage] ?? opportunity.stage}</p>}
    </>
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
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const label = stage.startsWith("__queue_") ? SALES_QUEUE_LABELS[stage.slice(8) as SalesQueueGroup] : stage === "__ready_for_marina" ? "Pronto para Marina" : FUNNEL_STAGE_LABELS[stage] ?? stage;
  const marker = stage.includes("ready") ? "bg-orange-500" : stage.includes("no_response") ? "bg-slate-400" : stage.includes("waiting") || stage.includes("scheduled") ? "bg-cyan-500" : stage.includes("formalization") ? "bg-emerald-500" : "bg-blue-500";
  const sorted = queueMode ? sortSalesQueue(opportunities.map(o => ({ ...o, tasks: o.sales_state?.tasks })), new Date().toISOString()) : sortNewestSalesCards(opportunities);
  return (
    <section ref={setNodeRef} aria-label={label} className={`w-[300px] shrink-0 rounded-2xl bg-muted/45 p-3 ${isOver && !queueMode ? "ring-2 ring-primary/40" : ""}`}>
      <div className="mb-4 flex min-h-9 items-center gap-2 px-1"><span className={`h-5 w-1 shrink-0 rounded-full ${marker}`}/><h2 className="flex-1 text-sm font-medium">{label}</h2><span className="rounded-full bg-background px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{opportunities.length}</span></div>
      <div className="max-h-[calc(100dvh-20rem)] min-h-48 space-y-3 overflow-y-auto px-0.5 pb-1 [scrollbar-width:thin]">
        {sorted.map(o => <OpportunityCard key={o.id} opportunity={o} onEdit={onEdit} onOpen={onOpen}/>)}
        {!sorted.length && <p className="rounded-xl border border-dashed p-5 text-center text-xs leading-relaxed text-muted-foreground">Nenhum negócio nesta etapa</p>}
      </div>
    </section>
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
  const [activeOpportunity, setActiveOpportunity] = useState<OpportunityWithContact | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor));
  const stages = queueMode ? Object.keys(SALES_QUEUE_LABELS).map(k=>`__queue_${k}`) : [...(workspaceEnabled ? ["__ready_for_marina"] : []), ...FUNNEL_STAGES[operation]];

  function handleDragEnd(event: DragEndEvent) {
    draggedAt.current = Date.now();
    setActiveOpportunity(null);
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
      <DndContext sensors={sensors}
        onDragStart={event => {
          draggedAt.current = Date.now();
          setActiveOpportunity(opportunities.find(o => o.id === String(event.active.id)) ?? null);
        }}
        onDragCancel={() => { draggedAt.current = Date.now(); setActiveOpportunity(null); }}
        onDragEnd={handleDragEnd}>
        <div className="flex items-start gap-4 overflow-x-auto pb-4 [scrollbar-width:thin]">
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
        {mounted && createPortal(
          <DragOverlay zIndex={1000} dropAnimation={null}>
            {activeOpportunity && <div aria-hidden="true" data-kanban-drag-overlay className={`pointer-events-none cursor-grabbing rounded-2xl border bg-card p-4 text-sm shadow-xl ${activeOpportunity.sales_state?.hot ? "border-orange-300" : "border-primary/40"}`}>
              <OpportunityCardContent opportunity={activeOpportunity}/>
            </div>}
          </DragOverlay>,
          document.body,
        )}
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
