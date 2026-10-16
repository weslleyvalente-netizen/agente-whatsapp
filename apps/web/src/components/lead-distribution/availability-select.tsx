"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import type { SalesRep, SalesRepAvailability } from "@aula-agente/shared";

const LABELS: Record<SalesRepAvailability, string> = { available: "Disponível", paused: "Pausado", out: "Fora da distribuição" };

/** Aparece só para quem é vendedor (existe em sales_reps) e quando a distribuição está ligada. */
export function AvailabilitySelect({ userId }: { userId: string }) {
  const { currentOrg } = useOrganization();
  const [rep, setRep] = useState<SalesRep | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = currentOrg?.settings.lead_distribution_enabled === true;

  useEffect(() => {
    if (!currentOrg || !enabled) return;
    apiFetch(`/organizations/${currentOrg.id}/sales-reps`)
      .then((reps: SalesRep[]) => setRep(reps.find(r => r.user_id === userId) ?? null))
      .catch(() => setRep(null));
  }, [currentOrg, enabled, userId]);

  if (!enabled || !rep || !currentOrg) return null;
  const change = async (availability: SalesRepAvailability) => {
    setSaving(true); setError(null);
    try {
      const updated = await apiFetch(`/organizations/${currentOrg.id}/sales-reps/${rep.id}/availability`, { method: "PATCH", body: JSON.stringify({ availability }) });
      setRep(updated);
    } catch (err) { setError((err as Error).message || "Não foi possível alterar o status."); } finally { setSaving(false); }
  };
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="hidden text-muted-foreground md:inline">Meu status</span>
      <select aria-label="Minha disponibilidade" className="h-11 max-w-[11rem] rounded border bg-background p-1 md:h-auto md:max-w-none" disabled={saving} value={rep.availability} onChange={e => change(e.target.value as SalesRepAvailability)}>
        {(Object.keys(LABELS) as SalesRepAvailability[]).map(a => <option key={a} value={a}>{LABELS[a]}</option>)}
      </select>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </label>
  );
}
