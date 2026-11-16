"use client";
import { useState } from "react";
import { checkNoActionClosure, NO_ACTION_WAITING_JUSTIFICATIONS, NO_ACTION_WAITING_LABELS, type SalesRep } from "@aula-agente/shared";
import { Button } from "@/components/ui/button";
import {
  FOOTNOTE, GROUP_HINTS, GROUP_TITLES, readinessNotice, totalCount, triageRowView, type TriageGroupKey, type TriageResponse, type TriageRowDTO,
} from "@/lib/exception-triage-view";

export interface ExceptionTriageSectionProps {
  data: TriageResponse;
  reps: Pick<SalesRep, "id" | "display_name">[];
  busy: Record<string, boolean>;
  notice: { kind: "error" | "info"; text: string } | null;
  onAcknowledge: (id: string) => void;
  onConfirm: (id: string, repId: string, note: string) => void;
  onNoAction: (id: string, note: string, waitingJustification?: string) => void;
  onNudgeSeller: (id: string) => void;
}

function Row({ row, group, reps, busy, onAcknowledge, onConfirm, onNoAction, onNudgeSeller }: { row: TriageRowDTO; group: TriageGroupKey } & Omit<ExceptionTriageSectionProps, "data" | "notice">) {
  const v = triageRowView(row);
  const [repId, setRepId] = useState("");
  const [note, setNote] = useState("");
  const [justification, setJustification] = useState("");
  // Cliente ainda aguardando: só encerra "sem ação" com justificativa da lista fechada + nota de 20+ caracteres (o servidor confere de novo).
  const noAction = checkNoActionClosure({ clientWaiting: row.clientWaiting, justification: justification || null, note });
  return (
    <div className="mt-3 rounded-lg border bg-background p-3" data-testid={`triage-row-${row.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <a href={v.href} className="font-medium underline-offset-2 hover:underline">{v.client}</a>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{v.badge}</span>
        {row.lastReplyClass === "midia" && !row.hasCommercialReply && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs dark:bg-sky-900">Resposta em áudio/mídia (conteúdo não verificado)</span>}
        {row.needsOwnerConfirmation && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs dark:bg-amber-900">Sem aceite formal</span>}
      </div>
      <p className="text-xs text-muted-foreground">{v.reps} · {v.handoff} · {v.delay}</p>
      {v.waiting && <p className="text-xs font-medium text-destructive">{v.waiting}</p>}
      {v.acknowledged && <p className="text-xs text-muted-foreground">{v.acknowledged}</p>}
      {group !== "obsolete" && v.canActOnException && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy[row.id]} onClick={() => onAcknowledge(row.id)}>Reconhecer</Button>
          <select aria-label="Quem assumiu" className="rounded border bg-background p-1 text-sm" value={repId} onChange={e => setRepId(e.target.value)}>
            <option value="">Quem assumiu…</option>
            {reps.map(r => <option key={r.id} value={r.id}>{r.display_name}</option>)}
          </select>
          {row.clientWaiting && (
            <select aria-label="Justificativa (cliente ainda aguardando)" className="rounded border bg-background p-1 text-sm" value={justification} onChange={e => setJustification(e.target.value)}>
              <option value="">Justificativa (cliente aguardando)…</option>
              {NO_ACTION_WAITING_JUSTIFICATIONS.map(j => <option key={j} value={j}>{NO_ACTION_WAITING_LABELS[j]}</option>)}
            </select>
          )}
          <input aria-label="Nota" className="rounded border bg-background p-1 text-sm" placeholder="Nota (opcional; obrigatória sem ação)" value={note} onChange={e => setNote(e.target.value)} />
          <Button size="sm" disabled={busy[row.id] || !repId} onClick={() => onConfirm(row.id, repId, note)}>Confirmar quem assumiu</Button>
          <Button size="sm" variant="outline" disabled={busy[row.id] || !noAction.ok} onClick={() => onNoAction(row.id, note, justification || undefined)}>Sem ação necessária</Button>
        </div>
      )}
      {group !== "obsolete" && v.canActOnException && row.clientWaiting && (
        <p className="mt-1 text-xs text-muted-foreground">Cliente ainda aguardando: “Sem ação necessária” exige justificativa e nota de pelo menos 20 caracteres.</p>
      )}
      {group !== "obsolete" && v.canNudgeSeller && (
        <div className="mt-2"><Button size="sm" variant="outline" disabled={busy[row.id]} onClick={() => onNudgeSeller(row.id)}>Cutucar vendedor</Button></div>
      )}
    </div>
  );
}

/** Painel de triagem (atrás de settings.exception_triage_panel_enabled): urgentes, respondidas e obsoletas, com atraso desde o primeiro handoff. */
export function ExceptionTriageSection(props: ExceptionTriageSectionProps) {
  const { data, notice } = props;
  const groups: Array<[TriageGroupKey, TriageRowDTO[]]> = [["urgent", data.urgent ?? []], ["answered", data.answered ?? []], ["obsolete", data.obsolete ?? []]];
  return (
    <section aria-label="Exceções de SLA" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
      <h2 className="font-medium">Exceções de SLA <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{totalCount(data)}</span></h2>
      {readinessNotice(data.alertsMode, data.readiness) && <p role="alert" className="mt-1 text-xs font-medium text-destructive">{readinessNotice(data.alertsMode, data.readiness)}</p>}
      {data.alertsMode === "shadow" && <p className="text-xs text-muted-foreground">Avisos em modo sombra: registrados, nada é enviado.</p>}
      {notice && (notice.kind === "error" ? <p role="alert" className="mt-2 text-destructive">{notice.text}</p> : <p role="status" className="mt-2 text-muted-foreground">{notice.text}</p>)}
      {totalCount(data) === 0 && <p className="mt-1 text-muted-foreground">Nenhuma exceção no momento.</p>}
      {groups.map(([key, rows]) => rows.length > 0 && (
        <div key={key} className="mt-4 border-t pt-3" aria-label={GROUP_TITLES[key]}>
          <h3 className="font-medium">{GROUP_TITLES[key]} <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{rows.length}</span></h3>
          <p className="text-xs text-muted-foreground">{GROUP_HINTS[key]}</p>
          {rows.map(r => <Row key={r.id} row={r} group={key} {...props} />)}
        </div>
      ))}
      <p className="mt-4 text-xs text-muted-foreground">{FOOTNOTE}</p>
    </section>
  );
}
