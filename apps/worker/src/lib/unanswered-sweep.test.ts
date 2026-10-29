import { describe, expect, it } from "vitest";
import { decideSweepAction, isClosingAcknowledgement, type SweepFacts } from "./unanswered-sweep.js";

const now = new Date("2026-10-26T15:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const facts = (o: Partial<SweepFacts> = {}): SweepFacts => ({
  now, createdAt: ago(30), content: "Quero um consórcio", mediaType: null, hasOutboundAfter: false, aiRouted: true, aiProcessed: false,
  ignored: false, aiDisabled: false, frozen: false, isHumanTakeover: false, openHandoff: false,
  retriedAt: null, alerted: false, businessOpen: true, ...o,
});

describe("decideSweepAction", () => {
  it("retenta quando passou de 10 min e nunca foi retentado", () => {
    expect(decideSweepAction(facts({ createdAt: ago(11) }))).toEqual({ action: "retry" });
  });
  it("espera quando a mensagem tem menos de 10 min", () => {
    expect(decideSweepAction(facts({ createdAt: ago(9) }))).toEqual({ action: "skip", reason: "too_recent" });
  });
  it("fora de escopo acima de 24 h", () => {
    expect(decideSweepAction(facts({ createdAt: ago(24 * 60 + 1) }))).toEqual({ action: "skip", reason: "too_old" });
  });
  it.each([
    ["answered", { hasOutboundAfter: true }],
    ["ignored", { ignored: true }],
    ["ai_disabled", { aiDisabled: true }],
    ["frozen", { frozen: true }],
    ["ai_processed", { aiProcessed: true }],
    ["not_ai_routed", { aiRouted: false }],
    ["no_content", { content: "  ", mediaType: null }],
  ] as const)("pula: %s", (reason, o) => {
    expect(decideSweepAction(facts(o as any))).toEqual({ action: "skip", reason });
  });
  it("mensagem processada pela IA (silêncio deliberado) nunca é retentada nem avisada no caminho da IA", () => {
    expect(decideSweepAction(facts({ aiProcessed: true, createdAt: ago(40) }))).toEqual({ action: "skip", reason: "ai_processed" });
  });
  it("L2: no caminho humano a marca ai_processed NÃO suprime o aviso (e a IA nunca é retentada)", () => {
    expect(decideSweepAction(facts({ aiProcessed: true, isHumanTakeover: true, createdAt: ago(30) }))).toEqual({ action: "alert" });
    expect(decideSweepAction(facts({ aiProcessed: true, openHandoff: true, createdAt: ago(10) }))).toEqual({ action: "skip", reason: "human_pending" });
  });
  it("M-C: mais de 2 h sem retry anterior nunca vai para a IA; vai direto ao aviso humano (só em expediente, uma vez)", () => {
    expect(decideSweepAction(facts({ createdAt: ago(121) }))).toEqual({ action: "alert" });
    expect(decideSweepAction(facts({ createdAt: ago(121), businessOpen: false }))).toEqual({ action: "skip", reason: "outside_business_hours" });
    expect(decideSweepAction(facts({ createdAt: ago(121), alerted: true }))).toEqual({ action: "skip", reason: "already_alerted" });
    expect(decideSweepAction(facts({ createdAt: ago(119) }))).toEqual({ action: "retry" });
  });
  it("mensagem com mais de 2 h que já tinha retry segue o fluxo normal de espera de 15 min", () => {
    expect(decideSweepAction(facts({ createdAt: ago(200), retriedAt: ago(5) }))).toEqual({ action: "skip", reason: "retry_pending" });
  });
  it("sem a marca ai_routed_at nunca há retry (takeover liberado depois, IA reativada)", () => {
    expect(decideSweepAction(facts({ aiRouted: false, createdAt: ago(40) }))).toEqual({ action: "skip", reason: "not_ai_routed" });
    expect(decideSweepAction(facts({ aiRouted: false, retriedAt: ago(40) }))).toEqual({ action: "skip", reason: "not_ai_routed" });
  });
  it("caminho humano não depende da marca", () => {
    expect(decideSweepAction(facts({ aiRouted: false, isHumanTakeover: true, createdAt: ago(30) }))).toEqual({ action: "alert" });
  });
  it("mídia sem texto não é pulada", () => {
    expect(decideSweepAction(facts({ content: "", mediaType: "audio" }))).toEqual({ action: "retry" });
  });
  it("depois do retry, antes de 15 min, aguarda", () => {
    expect(decideSweepAction(facts({ retriedAt: ago(14) }))).toEqual({ action: "skip", reason: "retry_pending" });
  });
  it("15 min depois do retry, dentro do expediente, avisa", () => {
    expect(decideSweepAction(facts({ retriedAt: ago(15) }))).toEqual({ action: "alert" });
  });
  it("não avisa fora do expediente", () => {
    expect(decideSweepAction(facts({ retriedAt: ago(20), businessOpen: false }))).toEqual({ action: "skip", reason: "outside_business_hours" });
  });
  it("não avisa duas vezes", () => {
    expect(decideSweepAction(facts({ retriedAt: ago(20), alerted: true }))).toEqual({ action: "skip", reason: "already_alerted" });
  });
  it("atendimento humano: nunca retenta; só avisa após 25 min", () => {
    expect(decideSweepAction(facts({ isHumanTakeover: true, createdAt: ago(20) }))).toEqual({ action: "skip", reason: "human_pending" });
    expect(decideSweepAction(facts({ isHumanTakeover: true, createdAt: ago(25) }))).toEqual({ action: "alert" });
    expect(decideSweepAction(facts({ openHandoff: true, createdAt: ago(40), businessOpen: false }))).toEqual({ action: "skip", reason: "outside_business_hours" });
    expect(decideSweepAction(facts({ openHandoff: true, createdAt: ago(40), alerted: true }))).toEqual({ action: "skip", reason: "already_alerted" });
  });
});

describe("isClosingAcknowledgement", () => {
  it.each([
    "Ok", "ok", "OK!", "okay", "Blz", "beleza", "Certo", "Combinado", "entendi", "Perfeito", "show", "Valeu", "valeu!!", "Obrigado", "Obrigada!", "obg", "tmj",
    "tranquilo", "tá bom", "Ta bom", "Muito obrigado", "ok obrigada", "okkk", "👍", "🙏", "❤️", "👍🏽", "ok 👍",
    "amanhã na parte da manhã eu pego", "depois eu passo aí", "mais tarde eu ligo", "semana que vem eu vejo", "Amanhã eu vou ligar",
  ])("encerramento/adiamento: %j", (text) => {
    expect(isClosingAcknowledgement(text)).toBe(true);
  });
  it.each([
    "Boa-tarde", "Boa tarde", "bom dia", "Oi", "tudo bem", "Tudo bem?", "Eu tenho interesse mas no momento estou", "[audio]", "", "   ",
    "ok, qual o valor da parcela?", "ok?", "ok 11 99999-0000", "ok pode ser 50000 reais", "ok R$ 1.500", "amanhã eu passo aí com 30 mil de entrada pra fechar tudo",
    "ok mas queria saber mais sobre o consórcio de moto", "Quero um consórcio de caminhão", "amanhã", "eu quero",
  ])("não filtra: %j", (text) => {
    expect(isClosingAcknowledgement(text)).toBe(false);
  });
  it("texto longo (> 60 caracteres) nunca é encerramento", () => {
    expect(isClosingAcknowledgement("ok ".repeat(30))).toBe(false);
  });
});

describe("decideSweepAction: acknowledgement", () => {
  it("pula encerramento em texto (após a checagem de no_content)", () => {
    expect(decideSweepAction(facts({ content: "Ok", createdAt: ago(30) }))).toEqual({ action: "skip", reason: "acknowledgement" });
    expect(decideSweepAction(facts({ content: "ok", mediaType: "text", createdAt: ago(30) }))).toEqual({ action: "skip", reason: "acknowledgement" });
    expect(decideSweepAction(facts({ content: "amanhã na parte da manhã eu pego", isHumanTakeover: true, createdAt: ago(30) }))).toEqual({ action: "skip", reason: "acknowledgement" });
    expect(decideSweepAction(facts({ content: " ", createdAt: ago(30) }))).toEqual({ action: "skip", reason: "no_content" });
  });
  it("não pula saudação, pergunta nem mídia", () => {
    expect(decideSweepAction(facts({ content: "Boa-tarde", createdAt: ago(11) }))).toEqual({ action: "retry" });
    expect(decideSweepAction(facts({ content: "[audio]", mediaType: "audio", createdAt: ago(11) }))).toEqual({ action: "retry" });
    expect(decideSweepAction(facts({ content: "ok", mediaType: "image", createdAt: ago(11) }))).toEqual({ action: "retry" });
  });
});
