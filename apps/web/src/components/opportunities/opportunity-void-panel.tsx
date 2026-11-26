"use client";
// Anular negócio que nunca foi oportunidade comercial válida (ex.: card de pós-venda). Só gestor; motivo obrigatório; reversível.
// Anulado fica fora do funil e de todos os indicadores (ganhos, perdas, conversão, metas).
import { useState } from "react";
import { Ban, Undo2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { voidActions, voidReasonError } from "@/lib/opportunity-void";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function OpportunityVoidPanel({ opportunityId, status, voidReason, isManager, onDone }: {
  opportunityId: string; status: string; voidReason?: string | null; isManager: boolean; onDone: () => void;
}) {
  const { canVoid, canUnvoid, isVoid } = voidActions(status, isManager);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = isVoid ? "unvoid" : "void";

  async function submit() {
    const invalid = voidReasonError(reason);
    if (invalid) { setError(invalid); return; }
    setSaving(true); setError(null);
    try {
      await apiFetch(`/opportunities/${opportunityId}/${action}`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
      setOpen(false); setReason(""); onDone();
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }

  if (!isVoid && !canVoid) return null;
  return (
    <div className="space-y-2">
      {isVoid && <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <strong>Negócio anulado</strong> — não conta como aberto, ganho ou perdido, nem em nenhum indicador.{voidReason ? <> Motivo: {voidReason}</> : null}
      </p>}
      {(canVoid || canUnvoid) && !open && <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => { setError(null); setOpen(true); }}>
        {isVoid ? <><Undo2 aria-hidden />Desfazer anulação</> : <><Ban aria-hidden />Anular (não era negócio)</>}
      </Button>}
      {open && <section className="space-y-3 rounded-lg border p-4" aria-label={isVoid ? "Desfazer anulação" : "Anular negócio"}>
        <h3 className="font-medium">{isVoid ? "Desfazer anulação" : "Anular negócio"}</h3>
        <p className="text-sm text-muted-foreground">{isVoid
          ? "O negócio volta exatamente ao estado de antes da anulação."
          : "Use quando o card nunca foi uma oportunidade comercial (pós-venda, suporte, duplicado). Fica registrado quem anulou e por quê, e dá para desfazer."}</p>
        <label className="block text-sm">Motivo (obrigatório)
          <Textarea className="mt-1" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: atendimento de pós-venda; o card foi aberto por um cadastro duplicado" />
        </label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button size="sm" className="max-md:h-11" disabled={saving} onClick={submit}>{isVoid ? "Desfazer anulação" : "Anular negócio"}</Button>
          <Button size="sm" className="max-md:h-11" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>Cancelar</Button>
        </div>
      </section>}
    </div>
  );
}
