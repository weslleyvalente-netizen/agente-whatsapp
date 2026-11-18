import {
  STALE_GUARD_MIN_MINUTES, evaluateMessageAge, resolveStaleGuardMinutes, resolveStaleGuardMode,
  type MessageAgeStatus, type StaleGuardMode,
} from "./stale-message-guard.js";

// Núcleo da proteção contra mensagem ATRASADA, compartilhado pelo webhook (API) e pelo processamento (worker): as MESMAS regras nos dois pontos.
// Sem I/O próprio: tudo entra por `StaleGuardDeps`.
//  off     (padrão) nada muda e nem lê a organização;
//  shadow  só registra (metadata.stale_guard + log) o que faria; a IA responde como hoje;
//  on      a IA NÃO responde: a conversa passa para atendimento humano (takeover), sem mexer em dono nem em distribuição.
// Falhas (comportamento documentado em docs/superpowers/specs/2026-11-18-guarda-mensagem-atrasada.md):
//  - leitura da configuração falha: modo desconhecido, a proteção é opt-in, então segue como hoje (fail-open);
//  - modo "on" já conhecido: qualquer falha DEPOIS disso mantém a IA sem responder (fail-closed): falha ao checar "já respondida" conta
//    como não respondida; falha ao gravar a marca, ao ligar o takeover ou ao avisar nunca devolve a mensagem para a IA.

export type StaleGuardAction = "proceed" | "hold";
export interface StaleGuardDecision {
  action: StaleGuardAction;
  mode: StaleGuardMode;
  reason: "off" | "replay" | "fresh" | MessageAgeStatus | "stale_held" | "stale_already_answered" | "stale_shadow";
  ageMinutes: number | null;
  /** Só em "hold": a conversa está (ou ficou) em atendimento humano. false = o takeover não pôde ser gravado (o responsável foi avisado se possível). */
  humanQueued?: boolean;
}

interface Log { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void }

export interface StaleGuardDeps {
  readSettings(organizationId: string): Promise<{ stale_message_guard_mode?: unknown; stale_message_guard_minutes?: unknown } | null>;
  /** Existe resposta nossa na conversa depois deste instante? */
  answeredAfter(conversationId: string, afterIso: string): Promise<boolean>;
  stampMessage(messageId: string, patch: Record<string, unknown>): Promise<void>;
  /** Liga o takeover só se ainda não estiver ligado. true = ESTA chamada ligou (quem avisa); false = já estava ligado (outra mensagem/processo foi mais rápido). */
  claimTakeover(conversationId: string, nowIso: string): Promise<boolean>;
  /** Avisa quem deve atender: o responsável da conversa; sem responsável, os gestores. Devolve quantos pushes saíram. */
  notify(organizationId: string, targetUserId: string | null, payload: { title: string; body: string; url: string; tag: string }): Promise<number>;
  log: Log;
}

export interface StaleGuardInput {
  organizationId: string;
  conversation: { id: string; is_human_takeover?: boolean | null; assigned_to?: string | null };
  messageId: string;
  /** Instante ORIGINAL da mensagem, em segundos (messageTimestamp do WhatsApp). No worker, na falta dele, a hora de gravação. */
  messageTimestamp: unknown;
  /** Mensagem reenviada pela recuperação interna (cabeçalho com token): decisão já é da recuperação, a proteção não interfere. */
  isReplay: boolean;
  now?: Date;
  /** De onde a decisão foi tomada (só para log/evidência). */
  source?: "webhook" | "worker" | "worker_pre_send";
}

export async function applyStaleMessageGuard(deps: StaleGuardDeps, input: StaleGuardInput): Promise<StaleGuardDecision> {
  const proceed = (reason: StaleGuardDecision["reason"], mode: StaleGuardMode, ageMinutes: number | null = null): StaleGuardDecision => ({ action: "proceed", mode, reason, ageMinutes });
  const source = input.source ?? "webhook";
  try {
    if (input.isReplay) return proceed("replay", "off");
    const now = input.now ?? new Date();
    // Pré-filtro SEM ler o banco: abaixo do menor limite possível a mensagem é atual em qualquer configuração (tráfego normal não paga leitura).
    const pre = evaluateMessageAge({ messageTimestamp: input.messageTimestamp, now, thresholdMinutes: STALE_GUARD_MIN_MINUTES });
    if (pre.status === "future_clock_skew") deps.log.info({ conversationId: input.conversation.id, source }, "stale-guard: timestamp no futuro (relógio); seguindo como hoje");
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
    catch (err) { deps.log.error({ errName: (err as Error)?.name, conversationId: input.conversation.id, source }, "stale-guard: falha ao checar resposta posterior; tratando como não respondida"); }
    const ageMinutes = Math.round(ev.ageMinutes!);
    const evidence = { mode, source, age_minutes: ageMinutes, original_at: ev.originalAtIso, already_answered: answered, decided_at: now.toISOString() };

    if (mode === "shadow") {
      await deps.stampMessage(input.messageId, { stale_guard: { ...evidence, would: answered ? "skip_ai" : "hold_and_human" } }).catch((err) => deps.log.error({ errName: (err as Error)?.name }, "stale-guard: falha ao registrar a sombra"));
      deps.log.info({ conversationId: input.conversation.id, messageId: input.messageId, ageMinutes, answered, source }, "stale-guard: [SOMBRA] seguraria esta mensagem atrasada");
      return { action: "proceed", mode, reason: "stale_shadow", ageMinutes };
    }

    // mode === "on"
    await deps.stampMessage(input.messageId, { stale_guard: { ...evidence, action: answered ? "skip_ai" : "hold_and_human" } }).catch((err) => deps.log.error({ errName: (err as Error)?.name }, "stale-guard: falha ao registrar a retenção"));
    if (answered) {
      deps.log.info({ conversationId: input.conversation.id, messageId: input.messageId, ageMinutes, source }, "stale-guard: mensagem atrasada já respondida; IA não responde");
      return { action: "hold", mode, reason: "stale_already_answered", ageMinutes };
    }
    // Sem humano responsável também entra: o takeover coloca a conversa na fila de quem atende. Não grava dono, não distribui.
    // Atômico: com várias mensagens da mesma conversa só quem LIGOU o takeover avisa (sem push repetido).
    let humanQueued = !!input.conversation.is_human_takeover;
    let shouldNotify = false;
    if (!humanQueued) {
      try { const won = await deps.claimTakeover(input.conversation.id, now.toISOString()); humanQueued = true; shouldNotify = won; }
      catch (err) {
        deps.log.error({ errName: (err as Error)?.name, conversationId: input.conversation.id, source }, "stale-guard: falha ao passar para atendimento humano");
        shouldNotify = true; // sem takeover gravado, ao menos uma pessoa precisa saber
      }
    }
    if (shouldNotify) {
      try {
        await deps.notify(input.organizationId, input.conversation.assigned_to ?? null, {
          title: "Cliente aguardando resposta", body: `Mensagem recebida com atraso (${ageMinutes} min) depois de instabilidade da conexão. Responda manualmente.`,
          url: "/", tag: `stale-guard-${input.conversation.id}`,
        });
      } catch (err) { deps.log.error({ errName: (err as Error)?.name }, "stale-guard: falha ao avisar (a mensagem segue retida)"); }
    }
    deps.log.info({ conversationId: input.conversation.id, messageId: input.messageId, ageMinutes, humanQueued, notified: shouldNotify, source }, "stale-guard: mensagem atrasada retida; atendimento humano");
    return { action: "hold", mode, reason: "stale_held", ageMinutes, humanQueued };
  } catch (err) {
    // Falha inesperada ANTES de conhecer o modo (ex.: leitura da configuração): o atendimento segue como antes da proteção.
    deps.log.error({ errName: (err as Error)?.name, source }, "stale-guard: erro inesperado; seguindo como hoje");
    return proceed("off", "off");
  }
}
