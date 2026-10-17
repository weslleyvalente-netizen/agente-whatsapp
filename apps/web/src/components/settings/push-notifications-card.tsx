"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { unsubscribeThisDeviceOnLogout } from "@/lib/push-client";
import { getPushStatus, PUSH_STATUS_TEXT, urlBase64ToUint8Array, type PushStatus } from "@/lib/push";

function readEnv() {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  return {
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    isIos,
    standalone,
    permission: ("Notification" in window ? Notification.permission : "default") as "default" | "granted" | "denied",
  };
}

export function PushNotificationsCard() {
  const { currentOrg } = useOrganization();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const env = readEnv();
    let subscribed = false;
    let serverUnavailable = false;
    if (env.hasServiceWorker && env.hasPushManager) {
      try {
        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        const existing = await reg?.pushManager.getSubscription();
        subscribed = Boolean(existing);
        // Vincula o aparelho ao usuário logado agora (corrige aparelho trocado de usuário ou linha removida no servidor).
        if (existing && currentOrg && Notification.permission === "granted") {
          const json = existing.toJSON();
          try {
            await apiFetch("/push/subscribe", { method: "POST", body: JSON.stringify({ organizationId: currentOrg.id, endpoint: json.endpoint, keys: json.keys }) });
          } catch (err) {
            // 409: o aparelho pertence a outro usuário. Solta a assinatura local para poder ativar de novo.
            if ((err as { status?: number }).status === 409) { await existing.unsubscribe().catch(() => {}); subscribed = false; }
          }
        }
      } catch { /* sem registro ainda */ }
      try {
        const { publicKey } = await apiFetch("/push/public-key");
        serverUnavailable = !publicKey;
      } catch { /* mantém o estado local */ }
    }
    setStatus(getPushStatus({ ...env, subscribed, serverUnavailable }));
  }, [currentOrg]);

  // Lê o estado do navegador (API externa) ao montar.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refresh(); }, [refresh]);

  async function enable() {
    if (!currentOrg || busy) return;
    // O iOS só mostra o pedido de permissão enquanto o toque do usuário ainda é válido: pedir ANTES de qualquer await.
    const permissionRequest = Notification.requestPermission();
    setBusy(true); setMessage(null);
    try {
      const permission = await permissionRequest;
      if (permission !== "granted") { setMessage("Permissão não concedida."); return; }
      const { publicKey } = await apiFetch("/push/public-key");
      if (!publicKey) throw new Error("As notificações ainda não foram configuradas no servidor.");
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const subscription = (await reg.pushManager.getSubscription())
        ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      const json = subscription.toJSON();
      await apiFetch("/push/subscribe", {
        method: "POST",
        body: JSON.stringify({ organizationId: currentOrg.id, endpoint: json.endpoint, keys: json.keys }),
      });
      setMessage("Notificações ativadas.");
    } catch (err) {
      setMessage((err as Error).message || "Não foi possível ativar as notificações.");
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function disable() {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      await unsubscribeThisDeviceOnLogout();
      setMessage("Notificações desativadas neste aparelho.");
    } catch (err) {
      setMessage((err as Error).message || "Não foi possível desativar.");
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function sendTest() {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const result = await apiFetch("/push/test", { method: "POST" });
      setMessage(result?.sent ? "Teste enviado. A notificação deve aparecer em instantes." : "Nenhum aparelho recebeu o teste. Ative as notificações primeiro.");
    } catch (err) {
      setMessage((err as Error).message || "Não foi possível enviar o teste.");
    } finally {
      setBusy(false);
    }
  }

  const canEnable = status === "inactive";
  const active = status === "active";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {active ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
          Notificações neste aparelho
          {active && <Badge variant="secondary">Ativas</Badge>}
        </CardTitle>
        <CardDescription>Receba avisos de novos leads, mensagens de clientes e prazos, mesmo com o app fechado.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground" role="status">{status ? PUSH_STATUS_TEXT[status] : "Verificando..."}</p>
        <div className="flex flex-wrap gap-2">
          {canEnable && <Button onClick={enable} disabled={busy}>Ativar notificações</Button>}
          {active && <Button variant="outline" onClick={sendTest} disabled={busy}>Enviar teste</Button>}
          {active && <Button variant="outline" onClick={disable} disabled={busy}>Desativar</Button>}
        </div>
        {message && <p className="text-sm">{message}</p>}
      </CardContent>
    </Card>
  );
}
