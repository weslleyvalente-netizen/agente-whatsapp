"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { WAITING_ON_OPTIONS, WAITING_ON_LABELS } from "@aula-agente/shared";
import type { Opportunity, WaitingOn } from "@aula-agente/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface MemberOption {
  user_id: string;
  email: string;
  role: string;
}

// Amount fields are typed as `number | ""` in local state: an empty string
// is the only way an <input type="number"> can represent "no value" while
// the user is actively editing (React controlled inputs reject `null`/
// `undefined`), and it's cast back to `null` only at submit time.
function toAmountInput(value: number | null): number | "" {
  return value ?? "";
}

function fromAmountInput(value: number | ""): number | null {
  return value === "" ? null : value;
}

export function OpportunityEditDialog({
  opportunity,
  open,
  onOpenChange,
  onSaved,
}: {
  opportunity: Opportunity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { currentOrg } = useOrganization();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);

  const [ownerId, setOwnerId] = useState(opportunity.owner_id ?? "");
  const [productModel, setProductModel] = useState(opportunity.product_model ?? "");
  const [nextAction, setNextAction] = useState(opportunity.next_action ?? "");
  const [nextActionDueDate, setNextActionDueDate] = useState(opportunity.next_action_due_date ?? "");
  const [waitingOn, setWaitingOn] = useState<WaitingOn | "">(opportunity.waiting_on ?? "");
  const [waitingOnUntil, setWaitingOnUntil] = useState(opportunity.waiting_on_until ?? "");
  const [saleAmount, setSaleAmount] = useState(toAmountInput(opportunity.sale_amount));
  const [creditAmount, setCreditAmount] = useState(toAmountInput(opportunity.credit_amount));
  const [downPaymentAmount, setDownPaymentAmount] = useState(toAmountInput(opportunity.down_payment_amount));
  const [bidAmount, setBidAmount] = useState(toAmountInput(opportunity.bid_amount));
  const [targetInstallmentAmount, setTargetInstallmentAmount] = useState(
    toAmountInput(opportunity.target_installment_amount)
  );
  const [termMonths, setTermMonths] = useState(toAmountInput(opportunity.term_months));
  const [commercialNotes, setCommercialNotes] = useState(opportunity.commercial_notes ?? "");

  // Belt-and-suspenders re-seed: the parent (OpportunityKanban) currently
  // conditionally mounts this dialog (`{editing && <OpportunityEditDialog
  // .../>}`), so a fresh instance with fresh useState initializers already
  // covers "open card A, close, open card B." This effect only matters if
  // that mounting pattern ever changes to keep one persistent instance
  // around across different opportunities — kept intentionally rather than
  // relying on the parent never changing.
  useEffect(() => {
    if (!open) return;
    setOwnerId(opportunity.owner_id ?? "");
    setProductModel(opportunity.product_model ?? "");
    setNextAction(opportunity.next_action ?? "");
    setNextActionDueDate(opportunity.next_action_due_date ?? "");
    setWaitingOn(opportunity.waiting_on ?? "");
    setWaitingOnUntil(opportunity.waiting_on_until ?? "");
    setSaleAmount(toAmountInput(opportunity.sale_amount));
    setCreditAmount(toAmountInput(opportunity.credit_amount));
    setDownPaymentAmount(toAmountInput(opportunity.down_payment_amount));
    setBidAmount(toAmountInput(opportunity.bid_amount));
    setTargetInstallmentAmount(toAmountInput(opportunity.target_installment_amount));
    setTermMonths(toAmountInput(opportunity.term_months));
    setCommercialNotes(opportunity.commercial_notes ?? "");
    setError(null);
  }, [open, opportunity]);

  useEffect(() => {
    if (!open || !currentOrg) return;
    apiFetch(`/organizations/${currentOrg.id}/members/display`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [open, currentOrg]);

  async function handleSubmit() {
    if (!nextAction.trim() || !nextActionDueDate) {
      setError("Próxima ação e prazo são obrigatórios");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/opportunities/${opportunity.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          owner_id: ownerId || null,
          product_model: productModel || null,
          next_action: nextAction,
          next_action_due_date: nextActionDueDate,
          waiting_on: waitingOn || null,
          waiting_on_until: waitingOn === "scheduled_date" ? waitingOnUntil || null : null,
          sale_amount: fromAmountInput(saleAmount),
          credit_amount: fromAmountInput(creditAmount),
          down_payment_amount: fromAmountInput(downPaymentAmount),
          bid_amount: fromAmountInput(bidAmount),
          target_installment_amount: fromAmountInput(targetInstallmentAmount),
          term_months: fromAmountInput(termMonths),
          commercial_notes: commercialNotes || null,
        }),
      });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar oportunidade</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div>
            <Label htmlFor="edit_product_model">Modelo</Label>
            <Input id="edit_product_model" value={productModel} onChange={(e) => setProductModel(e.target.value)} />
          </div>
          <div>
            <Label>Responsável</Label>
            <Select value={ownerId} onValueChange={(v) => v && setOwnerId(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione um responsável" />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="edit_next_action">Próxima ação</Label>
            <Input id="edit_next_action" value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit_next_action_due_date">Prazo</Label>
            <Input
              id="edit_next_action_due_date"
              type="date"
              value={nextActionDueDate}
              onChange={(e) => setNextActionDueDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Aguardando</Label>
            <Select value={waitingOn} onValueChange={(v) => setWaitingOn((v as WaitingOn) || "")}>
              <SelectTrigger>
                <SelectValue placeholder="Não definido" />
              </SelectTrigger>
              <SelectContent>
                {WAITING_ON_OPTIONS.map((w) => (
                  <SelectItem key={w} value={w}>
                    {WAITING_ON_LABELS[w]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {waitingOn === "scheduled_date" && (
            <div>
              <Label htmlFor="edit_waiting_on_until">Data combinada</Label>
              <Input
                id="edit_waiting_on_until"
                type="date"
                value={waitingOnUntil}
                onChange={(e) => setWaitingOnUntil(e.target.value)}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="edit_sale_amount">Preço (R$)</Label>
              <Input
                id="edit_sale_amount"
                type="number"
                step="0.01"
                value={saleAmount}
                onChange={(e) => setSaleAmount(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="edit_credit_amount">Crédito (R$)</Label>
              <Input
                id="edit_credit_amount"
                type="number"
                step="0.01"
                value={creditAmount}
                onChange={(e) => setCreditAmount(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="edit_down_payment_amount">Entrada/lance (R$)</Label>
              <Input
                id="edit_down_payment_amount"
                type="number"
                step="0.01"
                value={downPaymentAmount}
                onChange={(e) => setDownPaymentAmount(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="edit_bid_amount">Lance (R$)</Label>
              <Input
                id="edit_bid_amount"
                type="number"
                step="0.01"
                value={bidAmount}
                onChange={(e) => setBidAmount(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="edit_target_installment_amount">Parcela desejada (R$)</Label>
              <Input
                id="edit_target_installment_amount"
                type="number"
                step="0.01"
                value={targetInstallmentAmount}
                onChange={(e) => setTargetInstallmentAmount(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="edit_term_months">Prazo (meses)</Label>
              <Input
                id="edit_term_months"
                type="number"
                value={termMonths}
                onChange={(e) => setTermMonths(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="edit_commercial_notes">Anotações</Label>
            <Textarea
              id="edit_commercial_notes"
              value={commercialNotes}
              onChange={(e) => setCommercialNotes(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button onClick={handleSubmit} disabled={saving} className="w-full">
            Salvar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
