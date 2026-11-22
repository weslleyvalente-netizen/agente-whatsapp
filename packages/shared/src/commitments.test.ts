import { describe, expect, it } from "vitest";
import { COMMITMENT_TASK_REASON, detectProposalEvidence, detectSellerPromise, isCommitmentTask, isWithinHistoryWindow, PROPOSAL_STAGES } from "./commitments.js";
import { DEFAULT_BUSINESS_CALENDAR } from "./business-calendar.js";

const cal = DEFAULT_BUSINESS_CALENDAR; // seg–sex 08:00–18:00, America/Sao_Paulo (UTC-3)
// 2026-11-23 é segunda.
const brt = (s: string) => new Date(`${s}-03:00`);

describe("detectProposalEvidence", () => {
  it("valor + termo comercial é evidência forte", () => {
    const r = detectProposalEvidence({ content: "Ficou assim: R$ 80.000 com entrada de 10 mil e parcelas de 1.200", mediaType: "text" });
    expect(r.strong).toBe(true);
    expect(r.evidence).toMatch(/valor/);
  });
  it("simulação com número sem R$ mas com milhar", () => {
    expect(detectProposalEvidence({ content: "Simulação: crédito 45.000, parcela 890,00", mediaType: "text" }).strong).toBe(true);
  });
  it("imagem sozinha (foto da moto) NÃO é proposta", () => {
    expect(detectProposalEvidence({ content: "", mediaType: "image" }).strong).toBe(false);
    expect(detectProposalEvidence({ content: "Olha que linda", mediaType: "image" }).strong).toBe(false);
  });
  it("valor sem termo comercial e termo sem valor NÃO são proposta", () => {
    expect(detectProposalEvidence({ content: "R$ 500", mediaType: "text" }).strong).toBe(false);
    expect(detectProposalEvidence({ content: "Vou montar sua proposta", mediaType: "text" }).strong).toBe(false);
  });
  it("CPF e telefone não contam como valor", () => {
    expect(detectProposalEvidence({ content: "Proposta no CPF 123.456.789-00", mediaType: "text" }).strong).toBe(false);
    expect(detectProposalEvidence({ content: "Parcela: me liga no 62 99999-1234", mediaType: "text" }).strong).toBe(false);
  });
  it("PDF com nome de proposta/simulação/orçamento é forte; PDF qualquer não", () => {
    expect(detectProposalEvidence({ content: "", mediaType: "document", fileName: "Proposta Fazer 250.pdf" }).strong).toBe(true);
    expect(detectProposalEvidence({ content: "segue a simulação", mediaType: "document", fileName: "arquivo.pdf" }).strong).toBe(true);
    expect(detectProposalEvidence({ content: "", mediaType: "document", fileName: "rg-frente.pdf" }).strong).toBe(false);
  });
  it("lista das etapas de proposta não inclui Negociação", () => {
    expect(PROPOSAL_STAGES).toEqual(["proposal_sent", "simulation_sent", "plan_term_presented"]);
  });
});

describe("detectSellerPromise", () => {
  const sent = brt("2026-11-23T10:00:00");
  it("'já te falo' = 30 min úteis", () => {
    const r = detectSellerPromise("Já te falo!", sent, cal)!;
    expect(r.kind).toBe("quick");
    expect(r.dueAt.toISOString()).toBe(brt("2026-11-23T10:30:00").toISOString());
  });
  it("'só um instante' = 30 min", () => {
    expect(detectSellerPromise("so um instante por favor", sent, cal)?.kind).toBe("quick");
  });
  it("'vou verificar' = 2 h úteis (padrão) e respeita o ajuste", () => {
    const r = detectSellerPromise("Vou verificar a condição e te retorno", sent, cal)!;
    expect(r.kind).toBe("standard");
    expect(r.dueAt.toISOString()).toBe(brt("2026-11-23T12:00:00").toISOString());
    expect(detectSellerPromise("vou consultar", sent, cal, 60)!.dueAt.toISOString()).toBe(brt("2026-11-23T11:00:00").toISOString());
  });
  it("2 h úteis atravessam o fechamento: 17:00 + 120 = dia seguinte 09:00", () => {
    expect(detectSellerPromise("vou confirmar com o banco", brt("2026-11-23T17:00:00"), cal)!.dueAt.toISOString()).toBe(brt("2026-11-24T09:00:00").toISOString());
  });
  it("horário explícito: 'te retorno às 15h' vence às 15:00 do mesmo dia", () => {
    const r = detectSellerPromise("Te retorno às 15h", sent, cal)!;
    expect(r.kind).toBe("explicit_time");
    expect(r.dueAt.toISOString()).toBe(brt("2026-11-23T15:00:00").toISOString());
  });
  it("horário explícito que já passou hoje vale para o próximo dia útil", () => {
    expect(detectSellerPromise("te retorno até as 9:30", brt("2026-11-23T16:00:00"), cal)!.dueAt.toISOString()).toBe(brt("2026-11-24T09:30:00").toISOString());
  });
  it("'amanhã às 9h' na sexta vence segunda 09:00", () => {
    expect(detectSellerPromise("te retorno amanhã às 9h", brt("2026-11-27T11:00:00"), cal)!.dueAt.toISOString()).toBe(brt("2026-11-30T09:00:00").toISOString());
  });
  it("'amanhã' sem hora = abertura do próximo dia útil + 2 h", () => {
    const r = detectSellerPromise("amanhã eu te retorno", sent, cal)!;
    expect(r.kind).toBe("tomorrow");
    expect(r.dueAt.toISOString()).toBe(brt("2026-11-24T10:00:00").toISOString());
  });
  it("'até 10 vezes' não é horário (até só vale com h ou :MM)", () => {
    expect(detectSellerPromise("Te mando a simulação em até 10 vezes", sent, cal)?.kind ?? null).not.toBe("explicit_time");
    expect(detectSellerPromise("te retorno até 16h", sent, cal)!.dueAt.toISOString()).toBe(brt("2026-11-23T16:00:00").toISOString());
    expect(detectSellerPromise("te retorno até 16:30", sent, cal)!.dueAt.toISOString()).toBe(brt("2026-11-23T16:30:00").toISOString());
  });
  it("mensagem genérica ou negada não é promessa", () => {
    expect(detectSellerPromise("Bom dia, tudo bem?", sent, cal)).toBeNull();
    expect(detectSellerPromise("ok", sent, cal)).toBeNull();
    expect(detectSellerPromise("Não vou verificar hoje, só segunda", sent, cal)).toBeNull();
    expect(detectSellerPromise("", sent, cal)).toBeNull();
  });
  it("horário ainda considera feriado (calendário com closedDates)", () => {
    const withHoliday = { ...cal, closedDates: ["2026-11-24"] };
    expect(detectSellerPromise("vou verificar", brt("2026-11-23T17:00:00"), withHoliday)!.dueAt.toISOString()).toBe(brt("2026-11-25T09:00:00").toISOString());
  });
});

describe("isWithinHistoryWindow", () => {
  it("mensagem com mais de 24 h é histórico", () => {
    const now = brt("2026-11-23T10:00:00");
    expect(isWithinHistoryWindow(brt("2026-11-22T10:30:00"), now)).toBe(true);
    expect(isWithinHistoryWindow(brt("2026-11-22T09:59:00"), now)).toBe(false);
  });
});

// Regressão da simulação de 22/11/2026 (7 dias reais, textos anonimizados): 8 dos 21 lembretes vinham de mensagens que citam
// valor + termo comercial mas NÃO são proposta nova. Elas não podem virar proposta; as ofertas reais continuam reconhecidas.
describe("detectProposalEvidence: retomada de conversa e pergunta de qualificação não são proposta nova", () => {
  it.each([
    "Bom dia, Ana! Passando conforme combinado pra continuar sua simulação do consórcio de automóvel. Pensou mais sobre o crédito de R$ 60 mil?",
    "Oi, João, tudo bem? Vi que você quer o crédito de R$ 50 mil pro carro e combinou de passar aqui segunda.",
    "Carlos, tudo bem? Soube que não rolou aprovação no financiamento, mas com os R$5.000 que você tinha separado dá pra seguir no consórcio.",
    "Oi Maria, tudo bem? Vi que ficamos sem resposta depois de falarmos sobre a Fazer 250 com aquela parcela de R$ 450,00.",
    "Pedro, bom dia! Fiquei pensando nas duas opções da carta: entrada de R$15.000 com parcelas de R$1.200 (60x) ou a de R$ 10.000 com parcelas de R$ 1.500.",
    "Bom dia! Vi que você tá juntando o valor pra fechar a carta de 50 mil à vista.",
    "Lucas, tudo bem? Fiquei naquela dúvida entre seguir pela carta de 40 mil com entrada ou esperar o lance.",
    "conseguiu vender o carro para seguirmos com o crédito de 60 mil?",
    // 2ª rodada da simulação (variantes reais que tinham escapado):
    "Ana, tudo bem? Sei que não rolou aprovação no financiamento, mas com os R$5.000 que você separou dá pra seguir no consórcio.",
    "Pedro, bom dia! Ficou pensando nas duas opções da carta: entrada de R$15.000 com parcelas de R$1.200 ou a de R$ 10.000?",
    "Lucas, tudo bem? Ficou naquela dúvida entre seguir pela carta de 40 mil com entrada ou esperar o lance?",
  ])("retomada: %s", (content) => {
    expect(detectProposalEvidence({ content, mediaType: "text" })).toMatchObject({ strong: false, excluded: "reengagement" });
  });
  it.each([
    "o consórcio de 50 a 60 mil, quanto de parcela pretende pagar mensal ?",
    "qual valor de entrada possui pra carta contemplada de 50 mil ?",
    "qual valor que possui de entrada pra carta contemplada de 80 mil?",
    "Quanto você consegue dar de entrada? A carta é de R$ 45.000",
    "qual valor que possui de entrada pra carta contemplada de 150.000", // sem "?", mas começa perguntando
  ])("pergunta de qualificação: %s", (content) => {
    expect(detectProposalEvidence({ content, mediaType: "text" })).toMatchObject({ strong: false, excluded: "qualification_question" });
  });
  it.each([
    "*MT | Carta Contemplada Yamaha* 📄 Crédito: R$ 45.000,00 💰 Entrada: R$ 12.000,00 📅 Parcelas: 60x R$ 890,00",
    "consórcio 50.000,00 80 x 650,00 60 x 820,00",
    "pre aprovado com R$ 10.000,00 de entrada 48 x R$ 1.250,00",
    "Segue a proposta: entrada R$ 5.000 e parcelas de R$ 450. O que acha?",
    "Qual parcela fica melhor pra você? Opção 1: entrada R$ 5.000 + 60x R$ 900; opção 2: entrada R$ 8.000 + 60x R$ 780",
    "tenho esse Polo 1.0 2022/23 highline valor 89.900",
  ])("oferta real continua sendo proposta: %s", (content) => {
    expect(detectProposalEvidence({ content, mediaType: "text" }).strong).toBe(true);
  });
  it("vendedor dizendo que VAI verificar não está apresentando proposta (é promessa)", () => {
    expect(detectProposalEvidence({ content: "tá bom, vou ver a carta com 5 mil de entrada então", mediaType: "text" })).toMatchObject({ strong: false, excluded: "pending_check" });
    expect(detectProposalEvidence({ content: "Vou verificar a parcela de R$ 450 com a administradora", mediaType: "text" })).toMatchObject({ strong: false, excluded: "pending_check" });
  });
  it("PDF de proposta continua forte mesmo com texto de retomada", () => {
    expect(detectProposalEvidence({ content: "Vi que ficou com dúvida, segue a proposta", mediaType: "document", fileName: "Proposta.pdf" }).strong).toBe(true);
  });
});

describe("tarefa da rotina de compromissos é identificável (independente da consolidação)", () => {
  it("reconhece só pelo tipo + motivo fixo da rotina", () => {
    expect(isCommitmentTask({ type: "return_customer", reason: COMMITMENT_TASK_REASON.return_customer })).toBe(true);
    expect(isCommitmentTask({ type: "proposal_followup", reason: COMMITMENT_TASK_REASON.proposal_followup })).toBe(true);
    expect(isCommitmentTask({ type: "return_customer", reason: "handoff" })).toBe(false);
    expect(isCommitmentTask({ type: "run_quote", reason: COMMITMENT_TASK_REASON.return_customer })).toBe(false);
    expect(isCommitmentTask({ type: "return_customer", reason: null })).toBe(false);
  });
});
