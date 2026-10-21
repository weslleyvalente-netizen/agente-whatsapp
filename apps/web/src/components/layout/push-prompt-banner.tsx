"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, X } from "lucide-react";
import { useOrganization } from "@/providers/organization-provider";
import { buttonVariants } from "@/components/ui/button";
import { getPushStatus, PUSH_BANNER_DISMISS_MS, PUSH_BANNER_STORAGE_KEY, shouldShowPushBanner, type PushStatus } from "@/lib/push";

function readDismissedUntil(): number | null {
  try {
    const v = Number(localStorage.getItem(PUSH_BANNER_STORAGE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

async function readStatus(): Promise<PushStatus> {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const hasServiceWorker = "serviceWorker" in navigator;
  const hasPushManager = "PushManager" in window;
  let subscribed = false;
  if (hasServiceWorker && hasPushManager) {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      subscribed = Boolean(await reg?.pushManager.getSubscription());
    } catch { /* sem registro ainda */ }
  }
  return getPushStatus({
    hasServiceWorker, hasPushManager, hasNotification: "Notification" in window, isIos, standalone,
    permission: ("Notification" in window ? Notification.permission : "default") as "default" | "granted" | "denied",
    subscribed,
  });
}

/** Faixa no topo para o vendedor ativar as notificações neste aparelho (o item do menu da conta passava despercebido). */
export function PushPromptBanner() {
  const { currentOrg } = useOrganization();
  const pathname = usePathname();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const flagOn = currentOrg?.settings.push_notifications_enabled === true;

  // Lê o estado do navegador (API externa) ao montar e ao trocar de tela.
  useEffect(() => {
    if (!flagOn) return;
    let cancelled = false;
    readStatus().then((s) => {
      if (cancelled) return;
      setStatus(s);
      setVisible(shouldShowPushBanner({ flagOn, status: s, pathname, dismissedUntil: readDismissedUntil(), now: Date.now() }));
    });
    return () => { cancelled = true; };
  }, [flagOn, pathname]);

  if (!visible) return null;

  const needsInstall = status === "needs-install";
  const denied = status === "denied";
  const text = needsInstall
    ? "Instale o app para receber aviso de lead novo: Compartilhar → Adicionar à Tela de Início."
    : denied
      ? "As notificações estão bloqueadas neste aparelho. Veja como liberar."
      : "Ative as notificações para receber aviso de lead novo e mensagem de cliente no celular.";

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 md:px-6">
      <Bell className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{text}</span>
      {!needsInstall && (
        <Link href="/notificacoes" className={buttonVariants({ size: "sm" })}>{denied ? "Ver como liberar" : "Ativar agora"}</Link>
      )}
      <button
        type="button"
        aria-label="Agora não"
        className="rounded p-1 hover:bg-blue-100"
        onClick={() => {
          const until = Date.now() + PUSH_BANNER_DISMISS_MS;
          try { localStorage.setItem(PUSH_BANNER_STORAGE_KEY, String(until)); } catch { /* sem armazenamento: some só nesta tela */ }
          setVisible(false);
        }}
      ><X className="h-4 w-4" /></button>
    </div>
  );
}
