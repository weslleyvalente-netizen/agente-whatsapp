"use client";

import { useEffect, useState } from "react";
import type { AdOrigin } from "@aula-agente/shared";
import { apiFetch } from "@/lib/api";
import { Separator } from "@/components/ui/separator";
import { AdOriginList } from "./ad-origin-list";

// Bloco recolhido do atendimento: só aparece quando o contato tem anúncio registrado (nada muda na tela caso contrário).
export function AdOriginPanel({ contactId }: { contactId: string }) {
  const [origin, setOrigin] = useState<AdOrigin | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOrigin(null);
    (apiFetch(`/contacts/${contactId}/ad-touches`) as Promise<AdOrigin>)
      .then((res) => { if (!cancelled) setOrigin(res); })
      .catch(() => { if (!cancelled) setOrigin(null); });
    return () => { cancelled = true; };
  }, [contactId]);

  if (!origin || origin.touches.length === 0) return null;
  return (
    <>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">Anúncio de origem ({origin.total_touches})</summary>
        <AdOriginList touches={origin.touches} firstTouchId={origin.first_touch_id} totalTouches={origin.total_touches} />
      </details>
      <Separator />
    </>
  );
}
