"use client";
import { useEffect, useState } from "react";
import { Phone } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  CALL_OUTCOMES, CALL_OUTCOME_LABELS, CALL_STRATEGIES, CALL_STRATEGY_LABELS, suggestCallStrategy,
  type CallOutcome, type CallStrategy,
} from "@aula-agente/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface CallLogEntry { id: string; strategy: CallStrategy; outcome: CallOutcome; note: string | null; rep_name?: string; called_at: string }

export function CallLogDialog({ opportunityId, onClose, onSaved, onRequestReturnTask }: {
  opportunityId: string; onClose: () => void; onSaved: () => void; onRequestReturnTask?: () => void;
}) {
  const suggested = suggestCallStrategy(opportunityId);
  const [strategy, setStrategy] = useState<CallStrategy>(suggested);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOutcome, setSavedOutcome] = useState<CallOutcome | null>(null);
  useEffect(() => { setStrategy(suggested); }, [suggested]);

  async function save() {
    if (!outcome || saving) return;
    setSaving(true); setError(null);
    try {
      await apiFetch(`/opportunities/${opportunityId}/call-logs`, { method: "POST", body: JSON.stringify({ strategy, outcome, ...(note.trim() ? { note: note.trim() } : {}) }) });
      onSaved();
      if (outcome === "callback" || outcome === "no_answer") setSavedOutcome(outcome); else onClose();
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }

  if (savedOutcome) return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Ligação registrada</DialogTitle></DialogHeader>
        <p className="text-sm">Não esqueça de criar uma tarefa de retorno para este lead (congelar o negócio cria a tarefa de retorno).</p>
        <div className="flex gap-2">
          {onRequestReturnTask && <Button onClick={() => { onClose(); onRequestReturnTask(); }}>Congelar e criar retorno</Button>}
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Phone className="h-4 w-4" aria-hidden />Registrar ligação</DialogTitle></DialogHeader>
        <p className="rounded-md bg-muted p-2 text-sm">Sugestão para este lead: <strong>{CALL_STRATEGY_LABELS[suggested]}</strong></p>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Como você abordou?</legend>
          {CALL_STRATEGIES.map(s => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input type="radio" name="call-strategy" checked={strategy === s} onChange={() => setStrategy(s)} disabled={saving} />
              {CALL_STRATEGY_LABELS[s]}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Resultado</legend>
          {CALL_OUTCOMES.map(o => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <input type="radio" name="call-outcome" checked={outcome === o} onChange={() => setOutcome(o)} disabled={saving} />
              {CALL_OUTCOME_LABELS[o]}
            </label>
          ))}
        </fieldset>
        <label className="block text-sm">Observação (opcional)<Textarea value={note} onChange={e => setNote(e.target.value)} disabled={saving} maxLength={2000} /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button disabled={saving || !outcome} onClick={save}>{saving ? "Salvando..." : "Salvar ligação"}</Button>
          <Button variant="outline" disabled={saving} onClick={onClose}>Cancelar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
