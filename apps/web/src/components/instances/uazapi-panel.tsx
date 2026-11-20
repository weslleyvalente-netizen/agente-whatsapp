"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { describeUazapiPanel } from "./uazapi-panel-state";

type Status = { provider: string; connected: boolean; status: string; qrcode: string | null; paircode: string | null };
type Switch = "uazapi" | "evolution";

export function UazapiPanel({ instanceId }: { instanceId: string }) {
  const [data, setData] = useState<Status | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Switch | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await apiFetch(`/instances/${instanceId}/uazapi/status`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao consultar a UAZAPI");
    }
  }, [instanceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const panel = data ? describeUazapiPanel(data) : null;

  useEffect(() => {
    if (!panel?.polling) return;
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [panel?.polling, refresh]);

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const info = await apiFetch(`/instances/${instanceId}/uazapi/connect`, {
        method: "POST",
        body: JSON.stringify(phone.trim() ? { phone: phone.trim() } : {}),
      });
      setData((prev) => ({ provider: prev?.provider ?? "evolution", connected: info.status === "connected", ...info }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao conectar");
    } finally {
      setBusy(false);
    }
  };

  const switchTo = async (provider: Switch) => {
    setBusy(true); setError(null);
    try {
      await apiFetch(`/instances/${instanceId}/provider`, { method: "PUT", body: JSON.stringify({ provider }) });
      setConfirm(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao trocar o provedor");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>WhatsApp pela UAZAPI</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {!data || !panel ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>Estado: <strong>{panel.label}</strong></span>
              <span>Em uso: <strong>{data.provider === "uazapi" ? "UAZAPI" : "Evolution"}</strong></span>
            </div>

            {panel.canConnect && (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder="Celular para código de pareamento (opcional)"
                  value={phone}
                  inputMode="numeric"
                  onChange={(e) => setPhone(e.target.value)}
                />
                <Button onClick={connect} disabled={busy}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Conectar UAZAPI
                </Button>
              </div>
            )}

            {data.status !== "connected" && data.qrcode && (
              <div className="flex justify-center">
                <img src={data.qrcode} alt="QR Code da UAZAPI" className="h-64 w-64" />
              </div>
            )}
            {data.status !== "connected" && data.paircode && (
              <p className="text-center text-2xl font-semibold tracking-widest">{data.paircode}</p>
            )}

            <div className="flex flex-wrap gap-2">
              {panel.canSwitchToUazapi && <Button onClick={() => setConfirm("uazapi")} disabled={busy}>Usar UAZAPI</Button>}
              {panel.canSwitchToEvolution && <Button variant="outline" onClick={() => setConfirm("evolution")} disabled={busy}>Voltar para Evolution</Button>}
            </div>
          </>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "uazapi" ? "Usar a UAZAPI nesta instância?" : "Voltar para a Evolution?"}</DialogTitle>
            <DialogDescription>
              {confirm === "uazapi"
                ? "As mensagens passam a ser recebidas e enviadas pela UAZAPI. A Evolution fica conectada como reserva. Vale em até 30 segundos."
                : "As mensagens voltam a ser recebidas e enviadas pela Evolution. Vale em até 30 segundos."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancelar</Button>} />
            <Button onClick={() => confirm && switchTo(confirm)} disabled={busy}>Confirmar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
