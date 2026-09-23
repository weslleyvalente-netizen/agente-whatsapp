"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { OPERATION_LABELS, FUNNEL_STAGES, FUNNEL_STAGE_LABELS } from "@aula-agente/shared";
import type { Operation } from "@aula-agente/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

interface MemberOption {
  user_id: string;
  email: string;
  role: string;
}

export function OpportunityForm({ operation, onSaved }: { operation: Operation; onSaved: () => void }) {
  const { currentOrg } = useOrganization();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactOption[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactOption | null>(null);

  const [members, setMembers] = useState<MemberOption[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [stage, setStage] = useState(FUNNEL_STAGES[operation][0]);
  const [productModel, setProductModel] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextActionDueDate, setNextActionDueDate] = useState("");

  useEffect(() => {
    if (!open || !currentOrg) return;
    apiFetch(`/organizations/${currentOrg.id}/members/display`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [open, currentOrg]);

  useEffect(() => {
    if (!contactQuery.trim() || contactQuery.trim().length < 2 || !currentOrg) {
      setContactResults([]);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    const timeout = setTimeout(async () => {
      const { data } = await supabase
        .from("wa_contacts")
        .select("id, name, phone")
        .eq("organization_id", currentOrg.id)
        .or(`name.ilike.%${contactQuery}%,phone.ilike.%${contactQuery}%`)
        .limit(8);
      if (!cancelled) setContactResults(data || []);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [contactQuery, currentOrg]);

  async function handleSubmit() {
    if (!selectedContact) {
      setError("Selecione um contato");
      return;
    }
    if (!ownerId) {
      setError("Selecione um responsável");
      return;
    }
    if (!nextAction.trim() || !nextActionDueDate) {
      setError("Próxima ação e prazo são obrigatórios");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/organizations/${currentOrg!.id}/opportunities`, {
        method: "POST",
        body: JSON.stringify({
          contact_id: selectedContact.id,
          operation,
          stage,
          product_model: productModel || null,
          owner_id: ownerId,
          next_action: nextAction,
          next_action_due_date: nextActionDueDate,
        }),
      });
      setOpen(false);
      setSelectedContact(null);
      setContactQuery("");
      setProductModel("");
      setNextAction("");
      setNextActionDueDate("");
      setOwnerId("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Nova oportunidade</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova oportunidade — {OPERATION_LABELS[operation]}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Contato</Label>
            {selectedContact ? (
              <div className="flex items-center justify-between rounded border p-2 text-sm">
                <span>{selectedContact.name || selectedContact.phone}</span>
                <Button variant="ghost" size="sm" onClick={() => setSelectedContact(null)}>
                  Trocar
                </Button>
              </div>
            ) : (
              <>
                <Input
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                  placeholder="Buscar por nome ou telefone"
                />
                {contactResults.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="block w-full rounded p-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setSelectedContact(c);
                      setContactResults([]);
                      setContactQuery("");
                    }}
                  >
                    {c.name || c.phone}
                  </button>
                ))}
              </>
            )}
          </div>
          <div>
            <Label>Estágio inicial</Label>
            <Select value={stage} onValueChange={(v) => v && setStage(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FUNNEL_STAGES[operation].map((s) => (
                  <SelectItem key={s} value={s}>
                    {FUNNEL_STAGE_LABELS[s] ?? s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="product_model">Modelo</Label>
            <Input id="product_model" value={productModel} onChange={(e) => setProductModel(e.target.value)} />
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
            <Label htmlFor="next_action">Próxima ação</Label>
            <Input id="next_action" value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="next_action_due_date">Prazo</Label>
            <Input
              id="next_action_due_date"
              type="date"
              value={nextActionDueDate}
              onChange={(e) => setNextActionDueDate(e.target.value)}
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
