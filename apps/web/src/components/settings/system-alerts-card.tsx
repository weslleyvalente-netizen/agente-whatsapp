"use client";

import { useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { normalizeAlertPhone } from "./health-alert-phone";

export function SystemAlertsCard() {
  const { currentOrg, refetch } = useOrganization();
  const { role } = useMyRole({ always: true });
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => { setPhone(currentOrg?.settings.health_alert_phone ?? ""); }, [currentOrg]);

  if (!currentOrg || (role !== "owner" && role !== "admin")) return null;

  const save = async () => {
    const parsed = normalizeAlertPhone(phone);
    if (!parsed.ok) { setMessage({ kind: "error", text: parsed.error }); return; }
    setSaving(true);
    setMessage(null);
    const { error } = await createClient()
      .from("organizations")
      .update({ settings: { ...currentOrg.settings, health_alert_phone: parsed.value } })
      .eq("id", currentOrg.id);
    if (error) setMessage({ kind: "error", text: "Não foi possível salvar." });
    else { await refetch(); setMessage({ kind: "ok", text: parsed.value ? "Salvo." : "Salvo: sem WhatsApp, apenas a faixa no painel." }); }
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alertas do sistema</CardTitle>
        <CardDescription>
          WhatsApp que recebe o aviso quando o sistema para de receber mensagens de clientes, o Redis cai ou o WhatsApp desconecta (só em horário comercial).
          Este número é independente do aviso de handoff. Deixe vazio para ver apenas a faixa vermelha no painel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="health-alert-phone">WhatsApp de alerta (com DDI)</Label>
          <Input id="health-alert-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Ex.: 5562999998888" />
        </div>
        {message && <p className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message.text}</p>}
        <Button onClick={save} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
      </CardContent>
    </Card>
  );
}
