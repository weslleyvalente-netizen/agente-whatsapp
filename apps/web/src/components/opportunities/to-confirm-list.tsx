"use client";
// Aba "A confirmar": cards criados sem produto identificado. O vendedor confirma o produto e o card vai para o funil certo,
// mantendo histórico, etapa (quando existe no funil de destino) e responsável.
import { useState } from "react";
import { FUNNEL_STAGE_LABELS, OPERATIONS, OPERATION_LABELS, type Operation } from "@aula-agente/shared";
import { apiFetch } from "@/lib/api";
import { formatPhone } from "@/lib/utils";
import { confirmPlan } from "@/lib/to-confirm";
import { Button } from "@/components/ui/button";
import type { OpportunityWithContact } from "./opportunity-kanban";

export function ToConfirmList({ opportunities, onOpen, onChanged }: { opportunities: OpportunityWithContact[]; onOpen: (o: OpportunityWithContact) => void; onChanged: () => void }) {
  const [choice, setChoice] = useState<Record<string, Operation>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm(o: OpportunityWithContact) {
    const target = choice[o.id];
    if (!target) { setError("Escolha o produto antes de confirmar."); return; }
    setSaving(o.id); setError(null);
    try {
      const plan = confirmPlan(o, target);
      await apiFetch(`/opportunities/${o.id}/operation`, { method: "POST", body: JSON.stringify({ operation: plan.operation, evidence: "Produto confirmado pelo vendedor na aba A confirmar" }) });
      if (plan.restoreStage) {
        await apiFetch(`/opportunities/${o.id}/stage`, { method: "POST", body: JSON.stringify({ stage: plan.restoreStage, evidence: "Etapa mantida ao confirmar o produto" }) });
      }
      onChanged();
    } catch (err) { setError((err as Error).message); } finally { setSaving(null); }
  }

  if (!opportunities.length) return <p className="text-sm text-muted-foreground">Nenhum negócio com produto a confirmar.</p>;
  return (
    <section className="space-y-3" aria-label="Negócios com produto a confirmar">
      <p className="text-sm text-muted-foreground">Cards criados quando o cliente foi encaminhado, antes de o produto ser identificado. Confirme o produto com o cliente: o card vai para o funil certo, com o mesmo responsável e histórico. Enquanto estiverem aqui, não contam nos números de venda de veículos.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {opportunities.map((o) => (
        <div key={o.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <button type="button" className="min-w-48 flex-1 text-left" onClick={() => onOpen(o)}>
            <strong>{o.wa_contacts?.name || "Sem nome"}</strong>
            <p className="text-sm text-muted-foreground">{formatPhone(o.wa_contacts?.phone)} · {FUNNEL_STAGE_LABELS[o.stage] ?? o.stage}</p>
          </button>
          <label className="flex items-center gap-2 text-sm max-md:w-full">Produto
            <select aria-label={`Produto de ${o.wa_contacts?.name ?? "cliente"}`} className="rounded border bg-background p-2 max-md:h-11 max-md:flex-1" value={choice[o.id] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [o.id]: e.target.value as Operation }))}>
              <option value="" disabled>Escolher…</option>
              {OPERATIONS.map((op) => <option key={op} value={op}>{OPERATION_LABELS[op]}</option>)}
            </select>
          </label>
          <Button size="sm" className="max-md:h-11 max-md:w-full" disabled={saving === o.id || !choice[o.id]} onClick={() => confirm(o)}>Confirmar produto</Button>
        </div>
      ))}
    </section>
  );
}
