import {
  claimHumanTakeover, getAdminClient, getOrganizationById, hasHumanMessageAfter, hasOutboundMessageAfter, listManagerUserIds, sendPushToUser,
  stampMessageMetadata,
} from "@aula-agente/database";
import { type StaleGuardDeps } from "@aula-agente/shared";

// Proteção contra mensagem atrasada no PROCESSAMENTO (fila lenta, retry do BullMQ, reinjeção do varredor). As regras são as mesmas do webhook
// (applyStaleMessageGuard em @aula-agente/shared); aqui só as dependências do worker e o instante usado para medir a idade.

const FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * Instante em que a mensagem foi ESCRITA, em segundos. Prefere metadata.wa_original_at (gravado pelo webhook a partir do messageTimestamp do
 * WhatsApp); na falta dele (mensagem antiga, sem timestamp no payload) usa a hora de gravação (created_at), o que ainda cobre fila atrasada,
 * retry e varredor. Um "original" depois da chegada (relógio errado) é ignorado.
 */
export function effectiveMessageTimestampSec(m: { created_at: string; metadata?: object | null }): number | undefined {
  const created = Date.parse(m.created_at);
  const raw = (m.metadata as Record<string, unknown> | null | undefined)?.wa_original_at;
  const original = typeof raw === "string" ? Date.parse(raw) : NaN;
  const t = Number.isFinite(original) && (!Number.isFinite(created) || original <= created + FUTURE_TOLERANCE_MS) ? original : created;
  return Number.isFinite(t) ? t / 1000 : undefined;
}

export const workerStaleGuardLog = { info: (o: unknown, msg: string) => console.log(msg, JSON.stringify(o)), error: (o: unknown, msg: string) => console.error(msg, JSON.stringify(o)) };

export const defaultWorkerStaleGuardDeps = (log = workerStaleGuardLog): StaleGuardDeps => ({
  async readSettings(organizationId) { return ((await getOrganizationById(getAdminClient(), organizationId)).settings ?? null) as never; },
  answeredAfter: (conversationId, afterIso) => hasOutboundMessageAfter(getAdminClient(), conversationId, afterIso),
  stampMessage: (messageId, patch) => stampMessageMetadata(getAdminClient(), messageId, patch),
  claimTakeover: (conversationId, nowIso) => claimHumanTakeover(getAdminClient(), conversationId, nowIso),
  async notify(organizationId, targetUserId, payload) {
    const db = getAdminClient();
    const users = targetUserId ? [targetUserId] : await listManagerUserIds(db, organizationId);
    let sent = 0;
    for (const id of users) { try { sent += (await sendPushToUser(db, id, payload, { organizationId })).sent; } catch { /* um destinatário sem assinatura válida não impede os demais */ } }
    return sent;
  },
  log,
});

/** Um humano respondeu depois deste instante? Falha de leitura = não (o takeover, relido no mesmo ponto, já protege o caso comum). */
export async function humanRepliedAfter(conversationId: string, afterIso: string): Promise<boolean> {
  try { return await hasHumanMessageAfter(getAdminClient(), conversationId, afterIso); } catch { return false; }
}
