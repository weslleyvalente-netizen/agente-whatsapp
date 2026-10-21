export type PushStatus = "unsupported" | "needs-install" | "denied" | "unavailable" | "inactive" | "active";

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isIos: boolean;
  standalone: boolean;
  permission: "default" | "granted" | "denied";
  /** O servidor não tem chaves VAPID configuradas. */
  serverUnavailable?: boolean;
  subscribed: boolean;
}

/** Estado do cartão "Notificações neste aparelho". No iOS o push só existe com o app instalado (Tela de Início). */
export function getPushStatus(env: PushEnv): PushStatus {
  if (env.isIos && !env.standalone) return "needs-install";
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return "unsupported";
  if (env.permission === "denied") return "denied";
  if (env.serverUnavailable) return "unavailable";
  return env.subscribed && env.permission === "granted" ? "active" : "inactive";
}

export const PUSH_STATUS_TEXT: Record<PushStatus, string> = {
  unsupported: "Este navegador não suporta notificações push.",
  "needs-install": "No iPhone, instale o app primeiro: toque em Compartilhar e depois em \"Adicionar à Tela de Início\". Abra o app pelo ícone e volte aqui para ativar.",
  denied: "As notificações estão bloqueadas para este site. Libere nas configurações do navegador/aparelho e tente de novo.",
  unavailable: "As notificações ainda não foram configuradas no servidor.",
  inactive: "As notificações estão desativadas neste aparelho.",
  active: "Notificações ativas neste aparelho.",
};

/** Chave pública VAPID (base64url) → bytes, formato esperado por pushManager.subscribe. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const PUSH_BANNER_DISMISS_MS = 24 * 60 * 60 * 1000;
export const PUSH_BANNER_STORAGE_KEY = "push-banner-dismissed-until";

/** Aviso no topo do CRM para quem ainda não ativou as notificações neste aparelho. Só com o recurso ligado na organização. */
export function shouldShowPushBanner(opts: {
  flagOn: boolean;
  status: PushStatus | null;
  pathname: string;
  dismissedUntil: number | null;
  now: number;
}): boolean {
  if (!opts.flagOn || opts.status === null) return false;
  if (opts.pathname.startsWith("/notificacoes")) return false; // já está na tela de ativar
  if (opts.status !== "inactive" && opts.status !== "needs-install" && opts.status !== "denied") return false;
  return opts.dismissedUntil === null || opts.now >= opts.dismissedUntil;
}
