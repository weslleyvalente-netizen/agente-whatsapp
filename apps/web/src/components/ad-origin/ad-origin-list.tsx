import type { AdTouchView } from "@aula-agente/shared";
import { adPlatformLabel, adTouchHeading, formatAdTouchDate, safeAdUrl } from "@/lib/ad-origin";

export interface AdOriginListProps {
  touches: AdTouchView[];
  /** Toque que originou a oportunidade (só nos detalhes da oportunidade). */
  attributedId?: string | null;
}

// Detalhes do(s) anúncio(s) pelos quais o cliente chegou, do mais recente ao primeiro. Só aparece dentro de um bloco
// recolhido do atendimento/oportunidade: nada disso vai para os cards do funil.
export function AdOriginList({ touches, attributedId = null }: AdOriginListProps) {
  if (touches.length === 0) return null;
  const firstId = touches[touches.length - 1].id;
  return (
    <ul className="mt-2 space-y-3">
      {touches.map((t) => {
        const link = safeAdUrl(t.ad_url);
        return (
          <li key={t.id} className="border-l-2 pl-3 text-sm">
            <p className="font-medium break-words">{adTouchHeading(t)}</p>
            <p className="text-xs text-muted-foreground">
              {adPlatformLabel(t.platform)}
              {formatAdTouchDate(t.touched_at) ? ` · ${formatAdTouchDate(t.touched_at)}` : ""}
              {touches.length > 1 && t.id === firstId ? " · primeiro anúncio" : ""}
              {attributedId === t.id ? " · originou este negócio" : ""}
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
  );
}
