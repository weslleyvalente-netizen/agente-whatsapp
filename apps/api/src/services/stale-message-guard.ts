import {
  getAdminClient, getOrganizationById, hasOutboundMessageAfter, listManagerUserIds, sendPushToUser, stampMessageMetadata, updateConversation,
} from "@aula-agente/database";
import {
  STALE_GUARD_MIN_MINUTES, evaluateMessageAge, resolveStaleGuardMinutes, resolveStaleGuardMode, type MessageAgeStatus, type StaleGuardMode,
} from "@aula-agente/shared";

// Proteção contra mensagem ATRASADA de cliente (ver packages/shared/src/stale-message-guard.ts).
// Roda no webhook, DEPOIS de a mensagem já estar gravada (nada é perdido nem duplicado) e ANTES de encaminhá-la à IA.
//  off     (padrão) nada muda e nem lê a organização;
//  shadow  só registra (metadata.stale_guard + log) o que faria; a IA responde como hoje;
//  on      a IA NÃO recebe a mensagem atrasada: a conversa passa para atendimento humano (takeover), sem mexer em dono nem em distribuição.
// Falha em qualquer etapa de LEITURA nunca bloqueia o atendimento (segue como hoje); a mensagem é sempre preservada.

export type StaleGuardAction = "proceed" | "hold";
export interface StaleGuardDecision {
  action: StaleGuardAction;
  mode: StaleGuardMode;
  reason: "off" | "replay" | "fresh" | MessageAgeStatus | "stale_held" | "stale_already_answered" | "stale_shadow";
  ageMinutes: number | null;
}

interface Log { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void }

export interface StaleGuardDeps {
  readSettings(organizationId: string): Promise<{ stale_message_guard_mode?: unknown; stale_message_guard_minutes?: unknown } | null>;
  /** Existe resposta nossa na conversa depois deste instante? */
  answeredAfter(conversationId: string, afterIso: string): Promise<boolean>;
  stampMessage(messageId: string, patch: Record<string, unknown>): Promise<void>;
  startTakeover(conversationId: string, nowIso: string): Promise<void>;
  /** Avisa quem deve atender: o responsável da conversa; sem responsável, os gestores. Devolve quantos pushes saíram. */
  notify(organizationId: string, targetUserId: string | null, payload: { title: string; body: string; url: string; tag: string }): Promise<number>;
  log: Log;
}

export interface StaleGuardInput {
  organizationId: string;
  conversation: { id: string; is_human_takeover?: boolean | null; assigned_to?: string | null };
  messageId: string;
  /** messageTimestamp do payload (segundos). */
  messageTimestamp: unknown;
  /** Mensagem reenviada pela recuperação interna (cabeçalho com token): decisão já é da recuperação, a proteção não interfere. */
  isReplay: boolean;
  now?: Date;
}

export const defaultStaleGuardDeps = (log: Log): StaleGuardDeps => ({
  async readSettings(organizationId) { return ((await getOrganizationById(getAdminClient(), organizationId)).settings ?? null) as never; },
  answeredAfter: (conversationId, afterIso) => hasOutboundMessageAfter(getAdminClient(), conversationId, afterIso),
  stampMessage: (messageId, patch) => stampMessageMetadata(getAdminClient(), messageId, patch),
  async startTakeover(conversationId, nowIso) { await updateConversation(getAdminClient(), conversationId, { is_human_takeover: true, human_takeover_at: nowIso }); },
  async notify(organizationId, targetUserId, payload) {
    const db = getAdminClient();
    const users = targetUserId ? [targetUserId] : await listManagerUserIds(db, organizationId);
    let sent = 0;
    for (const id of users) { try { sent += (await sendPushToUser(db, id, payload, { organizationId })).sent; } catch { /* um destinatário sem assinatura válida não impede os demais */ } }
    return sent;
  },
  log,
});

export async function applyStaleMessageGuard(deps: StaleGuardDeps, input: StaleGuardInput): Promise<StaleGuardDecision> {
  const proceed = (reason: StaleGuardDecision["reason"], mode: StaleGuardMode, ageMinutes: number | null = null): StaleGuardDecision => ({ action: "proceed", mode, reason, ageMinutes });
  try {
    if (input.isReplay) return proceed("replay", "off");
    const now = input.now ?? new Date();
    // Pré-filtro SEM ler o banco: abaixo do menor limite possível a mensagem é atual em qualquer configuração (tráfego normal não paga leitura).
    const pre = evaluateMessageAge({ messageTimestamp: input.messageTimestamp, now, thresholdMinutes: STALE_GUARD_MIN_MINUTES });
    if (pre.status === "future_clock_skew") deps.log.info({ conversationId: input.conversation.id }, "stale-guard: timestamp no futuro (relógio); seguindo como hoje");
    if (pre.status !== "stale") return proceed(pre.status === "fresh" ? "fresh" : pre.status, "off", pre.ageMinutes);

    const settings = await deps.readSettings(input.organizationId);
    const mode = resolveStaleGuardMode(settings);
    if (mode === "off") return proceed("off", "off", pre.ageMinutes);
    const ev = evaluateMessageAge({ messageTimestamp: input.messageTimestamp, now, thresholdMinutes: resolveStaleGuardMinutes(settings) });
    if (ev.status !== "stale") return proceed("fresh", mode, ev.ageMinutes);

    // Já respondida (pelo celular da loja, por humano ou pela IA) depois do horário ORIGINAL: não há o que a IA responder nem motivo de takeover.
    // Se a consulta falhar, trata como NÃO respondida (a mensagem é atrasada e não dá para provar atendimento): vai para humano.
    let answered = false;
    try { answered = await deps.answeredAfter(input.conversation.id, ev.originalAtIso!); }
    catch (err) { deps.log.error({ errName: (err as Error)?.name, conversationId: input.conversation.id }, "stale-guard: falha ao checar resposta posterior; tratando como não respondida"); }
    const ageMinutes = Math.round(ev.ageMinutes!);
    const evidence = { mode, age_minutes: ageMinutes, original_at: ev.originalAtIso, already_answered: answered, decided_at: now.toISOString() };

    if (mode === "shadow") {
      await deps.stampMessage(input.messageId, { stale_guard: { ...evidence, would: answered ? "skip_ai" : "hold_and_human" } }).catch((err) => deps.log.error({ errName: (err as Error)?.name }, "stale-guard: falha ao registrar a sombra"));
      deps.log.info({ conversationId: input.conversation.id, messageId: input.messageId, ageMinutes, answered }, "stale-guard: [SOMBRA] seguraria esta mensagem atrasada");
      return { action: "proceed", mode, reason: "stale_shadow", ageMinutes };
    }

    // mode === "on"
    await deps.stampMessage(input.messageId, { stale_guard: { ...evidence, action: answered ? "skip_ai" : "hold_and_human" } }).catch((err) => deps.log.error({ errName: (err as Error)?.name }, "stale-guard: falha ao registrar a retenção"));
    if (answered) {
      deps.log.info({ conversationId: input.conversation.id, messageId: input.messageId, ageMinutes }, "stale-guard: mensagem atrasada já respondida; IA não responde");
      return { action: "hold", mode, reason: "stale_already_answered", ageMinutes };
    }
    // Sem humano responsável também entra: o takeover coloca a conversa na fila de quem atende (gestor quando não há dono). Não grava dono nem distribui.
    if (!input.conversation.is_human_takeover) {
      try { await deps.startTakeover(input.conversation.id, now.toISOString()); }
      catch (err) { deps.log.error({ errName: (err as Error)?.name, conversationId: input.conversation.id }, "stale-guard: falha ao passar para atendimento humano"); }
    }
    try {
      await deps.notify(input.organizationId, input.conversation.assigned_to ?? null, {
        title: "Cliente aguardando resposta", body: `Mensagem recebida com atraso (${ageMinutes} min) depois de instabilidade da conexão. Responda manualmente.`,
        url: "/", tag: `stale-guard-${input.conversation.id}`,
      });
    } catch (err) { deps.log.error({ errName: (err as Error)?.name }, "stale-guard: falha ao avisar (a mensagem segue retida)"); }
    deps.log.info({ conversationId: input.conversation.id, messageId: input.messageId, ageMinutes }, "stale-guard: mensagem atrasada retida; atendimento humano");
    return { action: "hold", mode, reason: "stale_held", ageMinutes };
  } catch (err) {
    // Qualquer falha inesperada: o atendimento segue como antes da proteção.
    deps.log.error({ errName: (err as Error)?.name }, "stale-guard: erro inesperado; seguindo como hoje");
    return proceed("off", "off");
  }
}
