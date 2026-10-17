import { apiFetch } from "@/lib/api";

interface SubscriptionLike { endpoint: string; unsubscribe(): Promise<boolean> }
interface RegistrationLike { pushManager: { getSubscription(): Promise<SubscriptionLike | null> } }

/**
 * Desvincula este aparelho do usuário atual: primeiro no servidor (para o push parar de ir ao aparelho
 * mesmo que o navegador falhe) e depois no navegador. Nunca lança (usado no logout).
 */
export async function unsubscribeThisDevice(
  getRegistration: () => Promise<RegistrationLike | undefined>,
  postUnsubscribe: (endpoint: string) => Promise<unknown>,
): Promise<void> {
  try {
    const subscription = await (await getRegistration())?.pushManager.getSubscription();
    if (!subscription) return;
    try { await postUnsubscribe(subscription.endpoint); } catch { /* segue: ainda assim cancela no navegador */ }
    try { await subscription.unsubscribe(); } catch { /* best effort */ }
  } catch { /* sem service worker/registro: nada a fazer */ }
}

/** Usado no logout, antes de encerrar a sessão (o POST precisa do token). */
export function unsubscribeThisDeviceOnLogout(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve();
  return unsubscribeThisDevice(
    () => navigator.serviceWorker.getRegistration("/sw.js"),
    (endpoint) => apiFetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }),
  );
}
