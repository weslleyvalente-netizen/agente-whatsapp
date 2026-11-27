import type { SalesRep, SlaAlert } from "@aula-agente/shared";
import { exceptionRow } from "@/lib/sla-alert-view";
import { SlaAlertsSection, type SlaAlertsSectionProps } from "./sla-alerts-section";

export interface DelayBoardProps extends Omit<SlaAlertsSectionProps, "alerts" | "reps"> {
  /** Clientes que o rodízio não conseguiu entregar a ninguém (ninguém respondeu no prazo). */
  exceptions: SlaAlert[];
  alerts: SlaAlert[];
  reps: Pick<SalesRep, "id" | "display_name">[];
}

/** Quadro "Atraso no atendimento" do funil: só aviso, sem escolher vendedor. A reatribuição, quando necessária, é feita na própria conversa (gestor). */
export function DelayBoard({ exceptions, alerts, ...rest }: DelayBoardProps) {
  if (!exceptions.length && !alerts.length) return null;
  const total = exceptions.length + alerts.length;
  return (
    <details open aria-label="Atraso no atendimento" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
      <summary className="cursor-pointer font-medium">Atraso no atendimento <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{total}</span></summary>
      {exceptions.length > 0 && (
        <div className="mt-3" aria-label="Clientes que nenhum vendedor respondeu">
          <h3 className="font-medium">Ninguém respondeu <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{exceptions.length}</span></h3>
          <p className="text-xs text-muted-foreground">O sistema não troca de vendedor sozinho. Abra a conversa: o gestor pode passar o cliente a outro vendedor em "Atribuir a…", no topo da conversa.</p>
          {exceptions.map((e) => {
            const row = exceptionRow(e, rest.now, rest.reps);
            return (
              <div key={e.id} className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <a href={row.href} className="font-medium underline-offset-2 hover:underline">{row.client}</a>
                <span className="text-muted-foreground">· {row.reason} · aguardando {row.waiting}{row.responsible ? ` · responsável: ${row.responsible}` : ""}</span>
              </div>
            );
          })}
        </div>
      )}
      <SlaAlertsSection alerts={alerts} {...rest} />
    </details>
  );
}
