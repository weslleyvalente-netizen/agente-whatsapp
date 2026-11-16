import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { durationLabel, readinessNotice, triageRowView, unconfirmedNotice, type TriageResponse, type TriageRowDTO } from "@/lib/exception-triage-view";
import { ExceptionTriageSection, type ExceptionTriageSectionProps } from "./exception-triage-section";

const row = (over: Partial<TriageRowDTO> = {}): TriageRowDTO => ({
  id: "e1", kind: "exception", conversationId: "c1", href: "/opportunities?conversa=c1", client: "Edivan Gomes", chainReps: ["Márcio", "Marina"], exceptionReason: "all_reps_sla_breached",
  state: "aguardando_atendimento_comercial", group: "urgente", clientWaiting: true, waitingSince: "2026-11-16T13:56:00Z", hasCommercialReply: false, needsOwnerConfirmation: false,
  handoffAt: "2026-11-13T16:18:00Z", flaggedAt: "2026-11-13T17:30:00Z", accumulatedBusinessMinutes: 462, accumulatedWallMinutes: 4000, events: [], ...over,
});
const props = (data: TriageResponse, over: Partial<ExceptionTriageSectionProps> = {}): ExceptionTriageSectionProps => ({
  data, reps: [{ id: "r1", display_name: "Marina" }], busy: {}, notice: null, onAcknowledge: () => {}, onConfirm: () => {}, onNoAction: () => {}, onNudgeSeller: () => {}, ...over,
});
const html = (p: ExceptionTriageSectionProps) => renderToStaticMarkup(<ExceptionTriageSection {...p} />);

describe("ExceptionTriageSection", () => {
  it("separa urgentes, respondidas e obsoletas em blocos próprios", () => {
    const out = html(props({
      enabled: true, urgent: [row()], answered: [row({ id: "e2", group: "respondida", state: "respondida_sem_aceite", clientWaiting: false, needsOwnerConfirmation: true, hasCommercialReply: true })],
      obsolete: [row({ id: "a1", kind: "alert", group: "obsoleta", state: "obsoleta", clientWaiting: false })],
    }));
    expect(out).toContain("Urgentes: aguardando atendimento comercial");
    expect(out).toContain("Respondidas, falta confirmar quem assumiu");
    expect(out).toContain("Obsoletas: atribuições antigas sem cliente aguardando");
    expect(out).toContain("Sem aceite formal");
  });
  it("mostra o handoff ORIGINAL e o atraso acumulado (úteis e corridos), não só o da exceção", () => {
    const out = html(props({ enabled: true, urgent: [row()] }));
    expect(out).toContain("Handoff original 13/11");
    expect(out).toContain("Atraso acumulado 7 h 42 min úteis");
    expect(out).toContain("2 d 18 h corridos");
    expect(out).toContain("Passou por Márcio e Marina");
    expect(out).toContain("Cliente aguardando desde 16/11");
  });
  it("exceção tem Reconhecer / Confirmar quem assumiu / Sem ação; NÃO tem Cutucar vendedor", () => {
    const out = html(props({ enabled: true, urgent: [row()] }));
    expect(out).toContain(">Reconhecer<");
    expect(out).toContain("Confirmar quem assumiu");
    expect(out).toContain("Sem ação necessária");
    expect(out).not.toContain("Cutucar vendedor</button>");
  });
  it("atribuição pendente (alert) mostra só Cutucar vendedor, e a nota deixa claro que não é follow-up ao cliente", () => {
    const out = html(props({ enabled: true, urgent: [row({ id: "a1", kind: "alert" })] }));
    expect(out).toContain(">Cutucar vendedor<");
    expect(out).not.toContain(">Reconhecer<");
    expect(out).toContain("nunca envia mensagem ao cliente");
    expect(out).toContain("follow-up automático ao cliente");
  });
  it("obsoletas são só informativas (sem botões de ação)", () => {
    const out = html(props({ enabled: true, obsolete: [row({ id: "a1", kind: "alert", group: "obsoleta", state: "obsoleta", clientWaiting: false })] }));
    expect(out).not.toContain(">Cutucar vendedor<");
    expect(out).not.toContain(">Reconhecer<");
    expect(out).toContain("Nada é fechado automaticamente");
  });
  it("modo sombra é sinalizado; vazio mostra mensagem; erro em role=alert", () => {
    expect(html(props({ enabled: true, alertsMode: "shadow", urgent: [] }))).toContain("modo sombra");
    expect(html(props({ enabled: true, urgent: [] }))).toContain("Nenhuma exceção no momento.");
    expect(html(props({ enabled: true, urgent: [] }, { notice: { kind: "error", text: "falhou" } }))).toContain('role="alert"');
  });
  it("reconhecimento anterior aparece na linha", () => {
    expect(html(props({ enabled: true, urgent: [row({ events: [{ kind: "acknowledged", at: "2026-11-16T14:00:00Z", repId: null, note: null }] })] }))).toContain("Reconhecida em 16/11");
  });
});

describe("modelo de visão", () => {
  it("durationLabel", () => {
    expect(durationLabel(0)).toBe("0 min");
    expect(durationLabel(59)).toBe("59 min");
    expect(durationLabel(61)).toBe("1 h 01 min");
    expect(durationLabel(60 * 50)).toBe("2 d 2 h");
  });
  it("triageRowView: ações por tipo", () => {
    expect(triageRowView(row())).toMatchObject({ canActOnException: true, canNudgeSeller: false, badge: "Exceção" });
    expect(triageRowView(row({ kind: "alert" }))).toMatchObject({ canActOnException: false, canNudgeSeller: true, badge: "Atribuição pendente" });
  });
});

describe("correções da revisão: cliente aguardando e prontidão", () => {
  it("cliente aguardando: mostra a justificativa (lista fechada) e o botão 'Sem ação necessária' nasce desabilitado", () => {
    const out = html(props({ enabled: true, urgent: [row({ clientWaiting: true })] }));
    expect(out).toContain("Justificativa (cliente ainda aguardando)");
    expect(out).toContain("Cliente já atendido fora do CRM");
    expect(out).toContain("pelo menos 20 caracteres");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Sem ação necessária<\/button>/);
  });
  it("sem cliente aguardando: não pede justificativa", () => {
    const out = html(props({ enabled: true, answered: [row({ group: "respondida", state: "respondida_sem_aceite", clientWaiting: false, needsOwnerConfirmation: true })] }));
    expect(out).not.toContain("Justificativa (cliente ainda aguardando)");
  });
  it("aviso de prontidão: some com off ou pronto; aparece com o motivo quando não pronto", () => {
    expect(readinessNotice("off", { ready: false, validManagerCount: 0, problems: ["no_recipients"] })).toBeNull();
    expect(readinessNotice("on", { ready: true, validManagerCount: 1, problems: [] })).toBeNull();
    expect(readinessNotice("shadow", { ready: false, validManagerCount: 0, problems: ["recipient_without_device", "no_valid_manager"] })).toMatch(/NÃO prontos.*aparelho.*Não ative o modo on/);
    expect(readinessNotice("on", { ready: false, validManagerCount: 0, problems: ["push_not_configured"] })).toMatch(/Nenhum alerta está sendo enviado/);
    expect(readinessNotice("shadow", null)).toMatch(/Não foi possível verificar/);
  });
  it("o painel exibe o aviso de prontidão", () => {
    const out = html(props({ enabled: true, alertsMode: "shadow", readiness: { ready: false, validManagerCount: 0, problems: ["no_recipients"] }, urgent: [row()] }));
    expect(out).toContain("Alertas NÃO prontos");
  });
});

describe("monitor de resultado desconhecido", () => {
  it("sem ocorrências não mostra nada; com ocorrências mostra a contagem sem afirmar entrega nem falha", () => {
    expect(unconfirmedNotice(0)).toBeNull();
    expect(unconfirmedNotice(null)).toBeNull();
    const n = unconfirmedNotice(3)!;
    expect(n).toMatch(/3 aviso\(s\).*resultado desconhecido.*entregues ou nunca/);
    expect(html(props({ enabled: true, alertsMode: "on", unconfirmedAlerts24h: 3, urgent: [row()] }))).toContain("resultado desconhecido");
  });
});
