"use client";

import { useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface RecoverResult {
  dryRun: boolean;
  instance: string;
  fetched: number;
  alreadyInCrm: number;
  toRecover: number;
  customers: number;
  replayed: number;
  failed: number;
  skipped: { groups: number; nonContent: number };
  sample: Array<{ phoneLast4: string; firstAt: string | null; lastAt: string | null; count: number }>;
}

// <input type="datetime-local"> trabalha com "YYYY-MM-DDTHH:mm" no horário local.
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RecoverMessagesCard() {
  const { currentOrg } = useOrganization();
  const { role } = useMyRole({ always: true });
  const [since, setSince] = useState(() => toLocalInput(new Date(Date.now() - 24 * 3600 * 1000)));
  const [until, setUntil] = useState(() => toLocalInput(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<RecoverResult | null>(null);
  const [done, setDone] = useState<RecoverResult | null>(null);

  if (!currentOrg || (role !== "owner" && role !== "admin")) return null;

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    if (dryRun) setDone(null);
    try {
      const result: RecoverResult = await apiFetch(`/organizations/${currentOrg.id}/admin/recover-messages`, {
        method: "POST",
        body: JSON.stringify({ since: new Date(since).toISOString(), until: new Date(until).toISOString(), dryRun }),
      });
      if (dryRun) setChecked(result);
      else { setDone(result); setChecked(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao consultar");
    } finally {
      setBusy(false);
    }
  };

  const recoverNow = async () => {
    if (!checked) return;
    const ok = window.confirm(
      `Recuperar ${checked.toRecover} mensagens de ${checked.customers} clientes?\n\nA IA vai responder esses clientes agora. Essa ação não pode ser desfeita.`
    );
    if (ok) await run(false);
  };

  const invalidWindow = !since || !until || new Date(since) >= new Date(until);

  return (
    <Card id="recuperar-mensagens">
      <CardHeader>
        <CardTitle>Recuperar mensagens perdidas</CardTitle>
        <CardDescription>
          Busca na Evolution as mensagens de clientes que não chegaram ao CRM (ex.: quando o Redis ficou fora do ar) e as reenvia pelo fluxo normal.
          Janela máxima de 7 dias. Rodar mais de uma vez não duplica nada.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="recover-since">De</Label>
            <Input id="recover-since" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="recover-until">Até</Label>
            <Input id="recover-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
        </div>

        <Button variant="outline" onClick={() => run(true)} disabled={busy || invalidWindow}>
          {busy ? "Aguarde..." : "Verificar"}
        </Button>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {checked && (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <p className="font-medium">
              {checked.toRecover === 0
                ? "Nenhuma mensagem pendente nessa janela."
                : `${checked.toRecover} mensagens de ${checked.customers} clientes não chegaram ao CRM.`}
            </p>
            <p className="text-muted-foreground">
              Encontradas na Evolution: {checked.fetched} · já no CRM: {checked.alreadyInCrm} · grupos/reações ignorados: {checked.skipped.groups + checked.skipped.nonContent}
            </p>
            {checked.sample.length > 0 && (
              <ul className="space-y-1 text-muted-foreground">
                {checked.sample.map((s) => (
                  <li key={`${s.phoneLast4}-${s.firstAt}`}>
                    Cliente final {s.phoneLast4}: {s.count} mensagem(ns)
                  </li>
                ))}
              </ul>
            )}
            {checked.toRecover > 0 && (
              <Button onClick={recoverNow} disabled={busy}>
                {busy ? "Recuperando..." : "Recuperar agora"}
              </Button>
            )}
          </div>
        )}

        {done && (
          <p className="rounded-md border p-3 text-sm">
            Concluído: {done.replayed} recuperadas, {done.failed} com falha{done.failed > 0 ? " (rode Verificar de novo para ver o que restou)" : ""}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
