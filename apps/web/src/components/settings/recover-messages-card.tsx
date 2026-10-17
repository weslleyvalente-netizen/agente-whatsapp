"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface Summary {
  instance: string;
  fetched: number;
  alreadyInCrm: number;
  toRecover: number;
  customers: number;
  answeredCustomers: number;
  skippedAnswered: number;
  savedNoAiReply: number;
  skipped: { groups: number; nonContent: number };
  note: string;
}
interface DryRunResult extends Summary {
  dryRun: true;
  sample: Array<{ phoneLast4: string; firstAt: string | null; lastAt: string | null; count: number }>;
}
interface RunStatus {
  state: "idle" | "running" | "done" | "failed";
  total?: number;
  done?: number;
  replayed?: number;
  failed?: number;
  summary?: Summary | null;
}

const POLL_MS = 3000;

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
  const [checked, setChecked] = useState<DryRunResult | null>(null);
  // Janela exata que foi verificada: "Recuperar agora" roda esta, nunca o que os campos mostram depois.
  const [checkedWindow, setCheckedWindow] = useState<{ since: string; until: string } | null>(null);
  const [run, setRun] = useState<RunStatus | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const orgId = currentOrg?.id;

  const stopPolling = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };

  const poll = useCallback(async () => {
    if (!orgId) return;
    try {
      const st: RunStatus = await apiFetch(`/organizations/${orgId}/admin/recover-messages/status`);
      setRun(st);
      if (st.state !== "running") stopPolling();
    } catch {
      // erro transitório de rede: mantém o último estado e tenta de novo no próximo ciclo
    }
  }, [orgId]);

  const startPolling = useCallback(() => {
    stopPolling();
    timer.current = setInterval(poll, POLL_MS);
    void poll();
  }, [poll]);

  // Ao abrir a página, retoma o acompanhamento de uma recuperação que já esteja rodando.
  useEffect(() => {
    if (!orgId || (role !== "owner" && role !== "admin")) return;
    apiFetch(`/organizations/${orgId}/admin/recover-messages/status`)
      .then((st: RunStatus) => { if (st.state === "running") { setRun(st); startPolling(); } })
      .catch(() => {});
    return stopPolling;
  }, [orgId, role, startPolling]);

  if (!currentOrg || (role !== "owner" && role !== "admin")) return null;

  const verify = async () => {
    setBusy(true); setError(null); setRun(null);
    try {
      const w = { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
      const result: DryRunResult = await apiFetch(`/organizations/${currentOrg.id}/admin/recover-messages`, {
        method: "POST", body: JSON.stringify({ ...w, dryRun: true }),
      });
      setChecked(result);
      setCheckedWindow(w);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao consultar");
    } finally {
      setBusy(false);
    }
  };

  const recoverNow = async () => {
    if (!checked || !checkedWindow) return;
    const ok = window.confirm(
      `Recuperar ${checked.toRecover} mensagens de ${checked.customers} clientes?\n\nA IA vai responder esses clientes agora. Essa ação não pode ser desfeita.`
    );
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await apiFetch(`/organizations/${currentOrg.id}/admin/recover-messages`, {
        method: "POST", body: JSON.stringify({ ...checkedWindow, dryRun: false }),
      });
      setChecked(null); setCheckedWindow(null);
      setRun({ state: "running", total: checked.toRecover, done: 0, replayed: 0, failed: 0 });
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao iniciar a recuperação");
    } finally {
      setBusy(false);
    }
  };

  const changeWindow = () => { setChecked(null); setCheckedWindow(null); };
  const running = run?.state === "running";
  const frozen = checkedWindow !== null || running;
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
            <Input id="recover-since" type="datetime-local" value={since} disabled={frozen} onChange={(e) => setSince(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="recover-until">Até</Label>
            <Input id="recover-until" type="datetime-local" value={until} disabled={frozen} onChange={(e) => setUntil(e.target.value)} />
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={verify} disabled={busy || running || invalidWindow}>
            {busy && !checked ? "Aguarde..." : "Verificar"}
          </Button>
          {checkedWindow && <Button variant="ghost" onClick={changeWindow} disabled={busy}>Alterar janela</Button>}
        </div>

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
            {checked.answeredCustomers > 0 && (
              <p className="text-amber-600">
                {checked.answeredCustomers} cliente(s) já receberam resposta depois da última mensagem perdida e não serão reenviados ({checked.skippedAnswered} mensagem(ns)).
              </p>
            )}
            {checked.savedNoAiReply > 0 && (
              <p className="text-amber-600">
                {checked.savedNoAiReply} mensagem(ns) serão salvas, sem resposta nova da IA, porque já existe uma resposta nossa mais recente na conversa.
              </p>
            )}
            {checked.sample.length > 0 && (
              <ul className="space-y-1 text-muted-foreground">
                {checked.sample.map((s) => (
                  <li key={`${s.phoneLast4}-${s.firstAt}`}>Cliente final {s.phoneLast4}: {s.count} mensagem(ns)</li>
                ))}
              </ul>
            )}
            {checked.toRecover > 0 && (
              <Button onClick={recoverNow} disabled={busy}>{busy ? "Iniciando..." : "Recuperar agora"}</Button>
            )}
          </div>
        )}

        {run && run.state !== "idle" && (
          <div className="space-y-1 rounded-md border p-3 text-sm" aria-live="polite">
            {run.state === "running" && (
              <p className="font-medium">Recuperando: {run.done ?? 0} de {run.total ?? 0} mensagens ({run.failed ?? 0} com falha)...</p>
            )}
            {run.state === "done" && (
              <p className="font-medium">
                Concluído: {run.replayed ?? 0} recuperadas, {run.failed ?? 0} com falha{(run.failed ?? 0) > 0 ? " (rode Verificar de novo para ver o que restou)" : ""}.
              </p>
            )}
            {run.state === "failed" && <p className="font-medium text-destructive">A recuperação falhou. Rode Verificar para ver o que restou.</p>}
            {run.summary?.note && run.state !== "running" && <p className="text-muted-foreground">{run.summary.note}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
