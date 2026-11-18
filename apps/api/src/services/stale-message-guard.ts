import {
  claimHumanTakeover, getAdminClient, getOrganizationById, hasOutboundMessageAfter, listManagerUserIds, sendPushToUser, stampMessageMetadata,
} from "@aula-agente/database";
import { type StaleGuardDeps } from "@aula-agente/shared";

// As regras da proteção vivem em @aula-agente/shared (stale-message-guard-core.ts), compartilhadas com o worker. Aqui só as dependências do webhook.
export { applyStaleMessageGuard } from "@aula-agente/shared";
export type { StaleGuardAction, StaleGuardDecision, StaleGuardDeps, StaleGuardInput } from "@aula-agente/shared";

interface Log { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void }

export const defaultStaleGuardDeps = (log: Log): StaleGuardDeps => ({
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
