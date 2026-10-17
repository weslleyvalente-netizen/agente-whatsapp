import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";

export interface PushPayload { title: string; body: string; url: string; tag?: string }
export interface PushSendResult { sent: number; removed: number; failed: number; skipped?: boolean }
type Env = Partial<Record<"VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT", string | undefined>>;
type Sender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, body: string, options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number }) => Promise<unknown>;

export function isPushConfigured(env: Env = process.env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

const defaultSender: Sender = (subscription, body, options) => webpush.sendNotification(subscription, body, options);

/**
 * Envia o push a todas as assinaturas do usuário. Sem chaves VAPID é inerte. 404/410 removem a assinatura;
 * a falha de um endpoint não impede os demais. Nunca loga endpoint nem chaves.
 */
export async function sendPushToUser(
  db: SupabaseClient, userId: string, payload: PushPayload, deps: { env?: Env; send?: Sender } = {},
): Promise<PushSendResult> {
  const env = deps.env ?? process.env;
  if (!isPushConfigured(env)) return { sent: 0, removed: 0, failed: 0, skipped: true };
  const send = deps.send ?? defaultSender;
  const { data, error } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  if (error) throw error;
  const vapidDetails = { subject: env.VAPID_SUBJECT!, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! };
  const body = JSON.stringify(payload);
  const gone: string[] = [];
  let sent = 0, failed = 0;
  for (const s of (data ?? []) as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>) {
    try {
      await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { vapidDetails, TTL: 3600 });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(s.id);
      else { failed++; console.error("Push send failed", { subscriptionId: s.id, status }); }
    }
  }
  if (gone.length) {
    const { error: delError } = await db.from("push_subscriptions").delete().in("id", gone);
    if (delError) console.error("Push: removing expired subscriptions failed", delError.message);
  }
  return { sent, removed: gone.length, failed };
}
