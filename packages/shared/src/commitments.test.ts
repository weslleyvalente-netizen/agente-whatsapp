import { describe, expect, it } from "vitest";
import { detectProposalEvidence, detectSellerPromise, isWithinHistoryWindow, PROPOSAL_STAGES } from "./commitments.js";
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
