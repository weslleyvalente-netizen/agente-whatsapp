"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function StageChangeDialog({
  open,
  fromLabel,
  toLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  fromLabel: string;
  toLabel: string;
  onConfirm: (evidence: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [evidence, setEvidence] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!evidence.trim()) {
      setError("Descreva a evidência dessa mudança de etapa.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onConfirm(evidence.trim());
      setEvidence("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Mover de &quot;{fromLabel}&quot; para &quot;{toLabel}&quot;
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="evidence">O que confirma essa mudança?</Label>
            <Textarea
              id="evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder='Ex: "Cliente confirmou a proposta por áudio às 14h32."'
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleConfirm} disabled={saving}>
              Confirmar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
