import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";

export interface PushPayload { title: string; body: string; url: string; tag?: string }
/**
 * `failed` = endpoints que não receberam (inclui os ambíguos, como antes). `ambiguous` é o SUBCONJUNTO de `failed` em que não dá para
 * descartar que o provedor tenha aceitado o push (timeout, conexão derrubada, 5xx): quem decide reenviar NÃO pode tratá-los como "não enviado".
 */
export interface PushSendResult { sent: number; removed: number; failed: number; ambiguous?: number; skipped?: boolean }

export type PushErrorClass = "gone" | "not_sent" | "ambiguous";
/** Erros de rede que ocorrem ANTES de qualquer byte chegar ao provedor (conexão nunca estabelecida): evidência de que nada foi enviado. */
const PRE_CONNECT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * Classifica o erro do web-push (v3.6, https nativo):
 *  - WebPushError com statusCode 404/410: assinatura expirada ("gone");
 *  - statusCode 4xx (exceto 408): o provedor RESPONDEU rejeitando a requisição ("not_sent");
 *  - erro de rede pré-conexão (DNS, recusa, rede inalcançável): nada saiu ("not_sent");
 *  - TUDO o mais (timeout/"Socket timeout", ECONNRESET, EPIPE, 408, 5xx, erro sem código): "ambiguous" — o provedor pode ter aceitado.
 */
export function classifyPushError(err: unknown): PushErrorClass {
  const e = err as { statusCode?: number; code?: string } | null;
  const status = e?.statusCode;
  if (status === 404 || status === 410) return "gone";
  if (typeof status === "number") return status >= 400 && status < 500 && status !== 408 ? "not_sent" : "ambiguous";
  if (e?.code && PRE_CONNECT_CODES.has(e.code)) return "not_sent";
  return "ambiguous";
}
type Env = Partial<Record<"VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT", string | undefined>>;
export type PushSender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, body: string, options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; timeout?: number }) => Promise<unknown>;

export function isPushConfigured(env: Env = process.env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/**
 * A leitura das assinaturas falhou ANTES de qualquer envio: nada saiu, então repetir é seguro (não duplica).
 * Qualquer outro erro, ou um envio por aparelho que falhou/expirou, NÃO prova que o provedor não recebeu o push (a resposta pode ter se perdido):
 * esses casos nunca devem ser repetidos automaticamente.
 */
export class PushNotAttemptedError extends Error {
  readonly attempted = false as const;
  constructor(readonly cause: unknown) { super(`Push não tentado: ${(cause as { message?: string } | null)?.message ?? "erro ao ler assinaturas"}`); }
}

const defaultSender: PushSender = (subscription, body, options) => webpush.sendNotification(subscription, body, options);

/**
 * Envia o push a todas as assinaturas do usuário. Sem chaves VAPID é inerte. 404/410 removem a assinatura;
 * a falha de um endpoint não impede os demais. Nunca loga endpoint nem chaves.
 */
export async function sendPushToUser(
  db: SupabaseClient, userId: string, payload: PushPayload, deps: { env?: Env; send?: PushSender; organizationId?: string } = {},
): Promise<PushSendResult> {
  const env = deps.env ?? process.env;
  if (!isPushConfigured(env)) return { sent: 0, removed: 0, failed: 0, skipped: true };
  const send = deps.send ?? defaultSender;
  let query = db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  // Só os aparelhos assinados nesta organização (quem está em duas organizações não recebe as dos outros contextos).
  if (deps.organizationId) query = query.eq("organization_id", deps.organizationId);
  const { data, error } = await query;
  if (error) throw new PushNotAttemptedError(error);
  const vapidDetails = { subject: env.VAPID_SUBJECT!, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! };
  const body = JSON.stringify(payload);
  const gone: string[] = [];
  let sent = 0, failed = 0, ambiguous = 0;
  for (const s of (data ?? []) as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>) {
    try {
      // timeout: sem ele uma resposta perdida deixaria o ciclo pendurado; com ele vira "Socket timeout" (ambíguo, tratado como tal).
      await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { vapidDetails, TTL: 3600, timeout: 15_000 });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const cls = classifyPushError(err);
      if (cls === "gone") gone.push(s.id);
      else { failed++; if (cls === "ambiguous") ambiguous++; console.error("Push send failed", { subscriptionId: s.id, status, outcome: cls }); }
    }
  }
  if (gone.length) {
    const { error: delError } = await db.from("push_subscriptions").delete().in("id", gone);
    if (delError) console.error("Push: removing expired subscriptions failed", delError.message);
  }
  return { sent, removed: gone.length, failed, ambiguous };
}
