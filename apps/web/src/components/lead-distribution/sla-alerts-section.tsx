import type { SalesRep, SlaAlert } from "@aula-agente/shared";
import { Button } from "@/components/ui/button";
import { slaAlertRow } from "@/lib/sla-alert-view";

export interface SlaAlertsSectionProps {
  alerts: SlaAlert[];
  reps: Pick<SalesRep, "id" | "display_name">[];
  /** Rótulo "Cutucado às HH:MM" por atribuição já cutucada nesta sessão. */
  nudged: Record<string, string>;
  /** Atribuições com envio em andamento. */
  busy: Record<string, boolean>;
  nudgingAll: boolean;
  /** Resultado/erro dos toques (erro em role="alert"). */
  notice: { kind: "error" | "info"; text: string } | null;
  now?: Date;
  onNudge: (id: string) => void;
  onNudgeAll: () => void;
}

/** Seção "Atrasos de resposta" do painel do gestor: cliente, vendedor, quanto venceu, link da conversa e botões Cutucar. */
export function SlaAlertsSection({ alerts, reps, nudged, busy, nudgingAll, notice, now, onNudge, onNudgeAll }: SlaAlertsSectionProps) {
  if (!alerts.length) return null;
  return (
    <div className="mt-4 border-t pt-3" aria-label="Atrasos de resposta na carteira">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Atrasos de resposta (clientes que já têm vendedor) <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{alerts.length}</span></h3>
        <Button size="sm" variant="outline" disabled={nudgingAll} onClick={onNudgeAll}>{nudgingAll ? "Enviando…" : "Cutucar todos"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Estes clientes continuam com o mesmo vendedor; não há redistribuição automática.</p>
      {notice && (notice.kind === "error"
        ? <p role="alert" className="mt-2 text-destructive">{notice.text}</p>
        : <p role="status" className="mt-2 text-muted-foreground">{notice.text}</p>)}
      {alerts.map((a) => {
        const row = slaAlertRow(a, reps, now);
        return (
          <div key={a.id} className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <a href={row.href} className="font-medium underline-offset-2 hover:underline">{row.client}</a>
            <span className="text-muted-foreground">· {row.repName} · {row.overdue}</span>
            {nudged[a.id]
              ? <span className="text-xs text-muted-foreground">{nudged[a.id]}</span>
              : <Button size="sm" variant="outline" disabled={busy[a.id] || nudgingAll} onClick={() => onNudge(a.id)}>{busy[a.id] ? "Enviando…" : "Cutucar"}</Button>}
          </div>
        );
      })}
    </div>
  );
}
