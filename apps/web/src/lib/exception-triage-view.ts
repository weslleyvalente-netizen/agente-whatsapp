// P0a: textos e agrupamento do painel de triagem de exceções. Funções puras (testáveis sem tela).
export type TriageGroupKey = "urgent" | "answered" | "obsolete";

export interface TriageRowDTO {
  id: string;
  kind: "exception" | "alert";
  conversationId: string;
  href: string;
  client: string;
  chainReps: string[];
  exceptionReason: string | null;
  state: "aguardando_atendimento_comercial" | "respondida_sem_aceite" | "resolvida" | "obsoleta";
  group: "urgente" | "respondida" | "obsoleta";
  clientWaiting: boolean;
  waitingSince: string | null;
  hasCommercialReply: boolean;
  lastReplyClass?: "saudacao" | "comercial" | "midia" | null;
  needsOwnerConfirmation: boolean;
  handoffAt: string;
  flaggedAt: string | null;
  accumulatedBusinessMinutes: number;
  accumulatedWallMinutes: number;
  events: Array<{ kind: string; at: string; repId: string | null; note: string | null }>;
}

export interface AlertReadinessDTO { ready: boolean; validManagerCount: number; problems: string[] }

export interface TriageResponse {
  enabled: boolean;
  alertsMode?: "off" | "shadow" | "on";
  /** Prontidão dos alertas (só quando o modo não é off). null = não foi possível verificar. */
  readiness?: AlertReadinessDTO | null;
  urgent?: TriageRowDTO[];
  answered?: TriageRowDTO[];
  obsolete?: TriageRowDTO[];
}

export const GROUP_TITLES: Record<TriageGroupKey, string> = {
  urgent: "Urgentes: aguardando atendimento comercial",
  answered: "Respondidas, falta confirmar quem assumiu",
  obsolete: "Obsoletas: atribuições antigas sem cliente aguardando",
};

export const GROUP_HINTS: Record<TriageGroupKey, string> = {
  urgent: "Sem resposta comercial de vendedor ou com o cliente esperando. Reconheça, confirme quem assumiu ou registre por que não há ação.",
  answered: "Houve resposta com conteúdo comercial, mas ninguém aceitou formalmente. A resposta pelo celular da loja não identifica o funcionário.",
  obsolete: "Nada é fechado automaticamente. Decisão do gestor.",
};

export const FOOTNOTE = "“Cutucar vendedor” é um aviso interno ao vendedor e nunca envia mensagem ao cliente. O follow-up automático ao cliente (MarIAna e tarefas) não é alterado por este painel.";

export function durationLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export const dayHour = (iso: string, timeZone = "America/Sao_Paulo"): string =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone });

export interface TriageRowView {
  id: string; client: string; href: string; reps: string; delay: string; handoff: string; waiting: string | null; acknowledged: string | null; badge: string;
  canActOnException: boolean; canNudgeSeller: boolean;
}

/** Texto de uma linha. O atraso é do PRIMEIRO handoff (nunca reiniciado pela exceção). */
export function triageRowView(r: TriageRowDTO): TriageRowView {
  const ack = r.events.filter(e => e.kind === "acknowledged").pop();
  return {
    id: r.id, client: r.client, href: r.href,
    reps: r.chainReps.length ? `Passou por ${r.chainReps.join(" e ")}` : "Sem vendedor registrado",
    delay: `Atraso acumulado ${durationLabel(r.accumulatedBusinessMinutes)} úteis (${durationLabel(r.accumulatedWallMinutes)} corridos)`,
    handoff: `Handoff original ${dayHour(r.handoffAt)}`,
    waiting: r.clientWaiting && r.waitingSince ? `Cliente aguardando desde ${dayHour(r.waitingSince)}` : null,
    acknowledged: ack ? `Reconhecida em ${dayHour(ack.at)}` : null,
    badge: r.kind === "exception" ? "Exceção" : "Atribuição pendente",
    canActOnException: r.kind === "exception",
    canNudgeSeller: r.kind === "alert",
  };
}

export function totalCount(d: TriageResponse): number {
  return (d.urgent?.length ?? 0) + (d.answered?.length ?? 0) + (d.obsolete?.length ?? 0);
}

const READINESS_PROBLEMS: Record<string, string> = {
  push_not_configured: "o push não está configurado no servidor",
  no_recipients: "nenhum destinatário administrativo cadastrado",
  recipient_not_member: "um destinatário não é mais membro da organização",
  recipient_not_admin: "um destinatário não é administrador (owner/admin)",
  recipient_without_device: "um destinatário administrativo não tem aparelho com push",
  no_valid_manager: "nenhum gestor válido com aparelho cadastrado",
};

/** Aviso do painel sobre a prontidão dos alertas; null quando não há o que avisar (modo off ou tudo pronto). */
export function readinessNotice(mode: TriageResponse["alertsMode"], readiness: TriageResponse["readiness"]): string | null {
  if (!mode || mode === "off") return null;
  if (readiness === null) return "Não foi possível verificar se os alertas estão prontos para ativar.";
  if (!readiness || readiness.ready) return null;
  const why = [...new Set(readiness.problems.map(p => READINESS_PROBLEMS[p] ?? p))].join("; ");
  const effect = mode === "on" ? "Nenhum alerta está sendo enviado" : "Não ative o modo on";
  return `Alertas NÃO prontos: ${why}. ${effect} até corrigir.`;
}
