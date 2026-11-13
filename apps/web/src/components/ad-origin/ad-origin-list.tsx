import type { AdTouchView, AttributionBasis } from "@aula-agente/shared";
import { adPlatformLabel, adTouchHeading, formatAdTouchDate, safeAdUrl } from "@/lib/ad-origin";

export interface AdOriginListProps {
  touches: AdTouchView[];
  /** Toque que originou a oportunidade (só nos detalhes da oportunidade). */
  attributedId?: string | null;
  /** Base da atribuição: ligado à conversa, pelo horário, ou indeterminada (nenhum anúncio com evidência). null fora de oportunidade. */
  attribution?: AttributionBasis | null;
  /** Toque mais antigo do contato (vem da API; a posição na lista não serve, pois ela pode estar truncada). */
  firstTouchId?: string | null;
  /** Total de toques do contato, para avisar quando a lista mostra só parte deles. */
  totalTouches?: number;
}

// Detalhes do(s) anúncio(s) pelos quais o cliente chegou, do mais recente ao primeiro. Só aparece dentro de um bloco
// recolhido do atendimento/oportunidade: nada disso vai para os cards do funil.
export function AdOriginList({ touches, attributedId = null, attribution = null, firstTouchId = null, totalTouches }: AdOriginListProps) {
  if (touches.length === 0) return null;
  const attributionNote = attribution === "conversation" ? " · originou este negócio (ligado à conversa)" : attribution === "time" ? " · originou este negócio (pelo horário)" : "";
  return (
    <div>
    {attribution === "indeterminate" && (
      <p role="status" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Origem do anúncio indeterminada: nenhum anúncio ligado a este negócio por conversa ou por data próxima.
      </p>
    )}
    <ul className="mt-2 space-y-3">
      {touches.map((t) => {
        const link = safeAdUrl(t.ad_url);
        return (
          <li key={t.id} className="border-l-2 pl-3 text-sm">
            <p className="font-medium break-words">{adTouchHeading(t)}</p>
            <p className="text-xs text-muted-foreground">
              {adPlatformLabel(t.platform)}
              {formatAdTouchDate(t.touched_at) ? ` · ${formatAdTouchDate(t.touched_at)}` : ""}
              {firstTouchId && touches.length > 1 && t.id === firstTouchId ? " · primeiro anúncio" : ""}
              {attributedId === t.id ? attributionNote : ""}
            </p>
            {t.ad_body && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{t.ad_body}</p>}
            {(t.campaign_name || t.campaign_id) && (
              <p className="text-xs text-muted-foreground">Campanha: {t.campaign_name ?? t.campaign_id}</p>
            )}
            {t.ad_id && <p className="text-xs text-muted-foreground">ID do anúncio: <span className="font-mono">{t.ad_id}</span></p>}
            {link && (
              <a href={link} target="_blank" rel="noopener noreferrer" className="break-all text-xs underline">
                Abrir anúncio
              </a>
            )}
          </li>
        );
      })}
    </ul>
    {totalTouches !== undefined && totalTouches > touches.length && (
      <p className="mt-2 text-xs text-muted-foreground">Mostrando {touches.length} de {totalTouches} anúncios.</p>
    )}
    </div>
  );
}
