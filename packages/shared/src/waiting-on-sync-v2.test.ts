import { describe, expect, it } from "vitest";
import {
  AWAITING_CUSTOMER_NEXT_ACTION, CUSTOMER_DECLINED_NEXT_ACTION, CUSTOMER_REPLIED_NEXT_ACTION, HANDOFF_AUTO_NEXT_ACTION, SELLER_PROMISED_NEXT_ACTION,
  classifyCustomerReply, classifySellerMessage, decideAttendanceCompleted, decideCustomerReplied, decideSellerMessage, resolveWaitingOnSyncMode,
  type OppFacts,
} from "./waiting-on-sync.js";

const opp = (over: Partial<OppFacts> = {}): OppFacts => ({ status: "open", stage: "decision_negotiation", waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION, frozen_until: null, waiting_on_until: null, ...over });
const AWAIT = { waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION };
const REPLIED = { waiting_on: "team", next_action: CUSTOMER_REPLIED_NEXT_ACTION };

describe("modo da sincronização", () => {
  it.each([[{ waiting_on_sync_mode: "shadow" }, "shadow"], [{ waiting_on_sync_mode: "on" }, "on"], [{ waiting_on_sync_mode: "off", waiting_on_sync_enabled: true }, "off"],
    [{ waiting_on_sync_enabled: true }, "on"], [{ waiting_on_sync_enabled: "true" }, "off"], [{}, "off"], [{ waiting_on_sync_mode: "ligado" }, "off"], [null, "off"]])("%j => %s", (s, m) => {
    expect(resolveWaitingOnSyncMode(s as never)).toBe(m);
  });
});

describe("classifyCustomerReply", () => {
  it.each([
    ["Não", "negative"], ["nao", "negative"], ["Não, obrigado", "negative"], ["sem interesse", "negative"], ["Já comprei", "negative"], ["desisti", "negative"],
    ["Não tenho o RG aqui", "answer"], ["Não consegui ver a proposta", "answer"],
    ["Sim", "answer"], ["Quero sim", "answer"], ["Qual o valor da entrada?", "answer"], ["529.982.247-25", "answer"],
    ["Ok", "ack"], ["blz", "ack"], ["Obrigado!", "ack"], ["👍", "ack"], ["kkkk", "ack"], ["Tudo bem", "ack"], ["", "ack"],
    ["[Cliente veio de um anúncio: Simule seu consórcio]", "ad_context"],
  ])("%j => %s", (text, kind) => expect(classifyCustomerReply(text)).toBe(kind));
  it("áudio, imagem, documento e vídeo são resposta (a equipe precisa olhar); figurinha não", () => {
    for (const m of ["audio", "image", "document", "video"]) expect(classifyCustomerReply(null, m)).toBe("media");
    expect(classifyCustomerReply("🎤 então eu queria saber da parcela", null)).toBe("media");
    expect(classifyCustomerReply("[audio]")).toBe("media");
    expect(classifyCustomerReply(null, "sticker")).toBe("ack");
  });
});

describe("classifySellerMessage (casos reais)", () => {
  it.each([
    ["consórcio 40.000   61 x 575,95  plano parcela reduzida ate a contemplação", "proposal"],
    ["36 x 822,76", "proposal"],
    ["*MT | Carta Contemplada YAMAHA* Entrada: R$ 8.100,00 Parcelas: 56x R$ 535,00", "proposal"],
    ["esse ficaria bom pra você ?", "asks"], ["qual modelo de carro voce ta procurando ?", "asks"], ["ainda tem interesse em seguir com o consórcio?", "asks"],
    ["me manda seu CPF por favor", "asks"],
    ["Te aviso", "promise"], ["vou verificar com o gerente", "promise"], ["um momento que já te retorno", "promise"], ["já te passo o valor", "promise"],
    ["Bom dia", "ack"], ["blz", "ack"], ["Boa tarde Marina", "info"],
    ["pegamos sim moto como entrada dependendo do ano e km rodados", "info"], ["tem que trazer na loja para avaliarmos", "info"],
  ])("%j => %s", (text, kind) => expect(classifySellerMessage(text)).toBe(kind));
  it("áudio do vendedor sem texto NÃO muda nada (não dá para saber o que foi dito); documento/imagem é proposta", () => {
    expect(classifySellerMessage(null, "audio")).toBe("media_audio");
    expect(classifySellerMessage("[audio]")).toBe("media_audio");
    expect(classifySellerMessage("Segue a simulação", "document")).toBe("proposal");
    expect(classifySellerMessage(null, "image")).toBe("proposal");
  });
  it("proposta com 'vou' no texto continua proposta; só promessa pura é promessa", () => {
    expect(classifySellerMessage("vou te mandar a opção: entrada R$ 8.000, 56x R$ 535")).toBe("proposal");
    expect(classifySellerMessage("vou te mandar a opção")).toBe("promise");
  });
});

describe("decideSellerMessage: não basta ser 'não trivial'", () => {
  const dec = (o: OppFacts, kind: Parameters<typeof decideSellerMessage>[0]["kind"], blocking = 0) => decideSellerMessage({ opportunity: o, kind, blockingOpenTasks: blocking, today: "2026-11-14" });
  it("proposta depois da resposta do cliente: volta para 'aguardando cliente' (o caso Romario)", () => {
    expect(dec(opp(REPLIED), "proposal")).toMatchObject({ action: "set_customer", rule: "seller_proposal", ...AWAIT });
    expect(dec(opp(REPLIED), "asks")).toMatchObject({ action: "set_customer", rule: "seller_question" });
  });
  it("com obrigação da equipe aberta (simulação, documentos, retorno agendado, financiamento): não muda", () => {
    expect(dec(opp(REPLIED), "proposal", 1)).toEqual({ action: "keep", reason: "other_open_tasks" });
  });
  it.each(["awaiting_simulation", "financing_rejected", "conditions_approved_negotiation", "bank_analysis"])("etapa da equipe (%s): não muda", (stage) => {
    expect(dec(opp({ ...REPLIED, stage }), "proposal")).toEqual({ action: "keep", reason: "team_owned_stage" });
  });
  it("congelado ou com data combinada futura: não muda; data passada não impede", () => {
    expect(dec(opp({ ...REPLIED, frozen_until: "2026-12-01" }), "proposal")).toEqual({ action: "keep", reason: "frozen" });
    expect(dec(opp({ ...REPLIED, waiting_on_until: "2026-11-20" }), "proposal")).toEqual({ action: "keep", reason: "scheduled_date_pending" });
    expect(dec(opp({ ...REPLIED, waiting_on_until: "2026-11-10" }), "proposal").action).toBe("set_customer");
  });
  it("edição humana nunca é sobrescrita (texto da próxima ação diferente do automático)", () => {
    expect(dec(opp({ waiting_on: "team", next_action: "Ligar amanhã às 10h" }), "proposal")).toEqual({ action: "keep", reason: "next_action_edited" });
    expect(dec(opp({ waiting_on: "team", next_action: null }), "proposal")).toEqual({ action: "keep", reason: "next_action_edited" });
  });
  it("outros 'aguardando' (banco, data combinada) e negócio fechado: não muda", () => {
    expect(dec(opp({ waiting_on: "bank_or_admin", next_action: CUSTOMER_REPLIED_NEXT_ACTION }), "proposal").action).toBe("keep");
    expect(dec(opp({ waiting_on: "scheduled_date", next_action: CUSTOMER_REPLIED_NEXT_ACTION }), "proposal").action).toBe("keep");
    expect(dec(opp({ ...REPLIED, status: "won" }), "proposal")).toEqual({ action: "keep", reason: "not_open" });
  });
  it("promessa de verificar/enviar: a bola é da equipe, mesmo se estava 'aguardando cliente'; repetida não regrava", () => {
    expect(dec(opp(AWAIT), "promise")).toMatchObject({ action: "set_team", rule: "seller_promise", next_action: SELLER_PROMISED_NEXT_ACTION });
    expect(dec(opp({ waiting_on: "team", next_action: SELLER_PROMISED_NEXT_ACTION }), "promise")).toEqual({ action: "keep", reason: "no_change" });
  });
  it("cortesia, informação e áudio do vendedor não mudam nada", () => {
    for (const k of ["ack", "info", "media_audio"] as const) expect(dec(opp(REPLIED), k)).toEqual({ action: "keep", reason: "no_change" });
  });
  it("depois de um 'não' do cliente NUNCA volta sozinho: a decisão é humana", () => {
    const declined = opp({ waiting_on: "team", next_action: CUSTOMER_DECLINED_NEXT_ACTION });
    for (const k of ["proposal", "asks", "promise", "info"] as const) expect(dec(declined, k).action).toBe("keep");
  });
});

describe("decideCustomerReplied: respostas e 'não'", () => {
  const dec = (reply: Parameters<typeof decideCustomerReplied>[0]["reply"], o = opp(AWAIT)) => decideCustomerReplied({ opportunity: o, reply, today: "2026-11-14" });
  it("resposta e mídia devolvem a bola à equipe", () => {
    expect(dec("answer")).toMatchObject({ action: "set_team", rule: "customer_replied", next_action: CUSTOMER_REPLIED_NEXT_ACTION });
    expect(dec("media")).toMatchObject({ action: "set_team", rule: "customer_replied" });
  });
  it("'Não' é resposta, mas NÃO presume continuidade: texto próprio e regra própria", () => {
    expect(dec("negative")).toMatchObject({ action: "set_team", rule: "customer_declined", next_action: CUSTOMER_DECLINED_NEXT_ACTION });
  });
  it("agradecimento e contexto de anúncio não mudam; congelado/data combinada/edição humana: nada", () => {
    expect(dec("ack")).toEqual({ action: "keep", reason: "not_substantive" });
    expect(dec("ad_context")).toEqual({ action: "keep", reason: "not_substantive" });
    expect(dec("answer", opp({ ...AWAIT, frozen_until: "2026-12-01" }))).toEqual({ action: "keep", reason: "frozen" });
    expect(dec("answer", opp({ waiting_on: "customer", next_action: "Aguardar documentos" }))).toEqual({ action: "keep", reason: "not_auto_waiting" });
  });
});

describe("conclusão do atendimento: cliente esperando a equipe não vira 'aguardando cliente'", () => {
  const base = { opportunity: opp(), completedTypes: ["return_customer"], humanRepliedAfterTaskCreated: true, otherOpenTasks: 0, today: "2026-11-14" };
  it("última mensagem é do cliente: mantém", () => expect(decideAttendanceCompleted({ ...base, lastMessageRole: "contact" })).toEqual({ action: "keep", reason: "customer_waiting" }));
  it("última é do vendedor: muda, com regra e motivo", () => expect(decideAttendanceCompleted({ ...base, lastMessageRole: "human_agent" })).toMatchObject({ action: "set_customer", rule: "attendance_completed" }));
  it("congelado / data combinada futura: mantém", () => {
    expect(decideAttendanceCompleted({ ...base, opportunity: opp({ frozen_until: "2026-12-01" }) })).toEqual({ action: "keep", reason: "frozen" });
    expect(decideAttendanceCompleted({ ...base, opportunity: opp({ waiting_on_until: "2026-12-01" }) })).toEqual({ action: "keep", reason: "scheduled_date_pending" });
  });
});

// ============================================================================================================================
// SIMULAÇÃO CONTRA OS 14 CASOS REAIS DA ONDA 0 (14/11/2026), anonimizada (sem nomes, telefones nem CPFs).
// Cada linha do tempo reproduz, na ordem, o que aconteceu depois que o vendedor concluiu a tarefa de atendimento do repasse.
// "esperado" = classificação proposta na fila de validação (ainda sujeita à validação de Marina e Márcio).
// ============================================================================================================================
type Ev = { k: "complete"; lastRole?: string } | { k: "c"; t?: string; m?: string } | { k: "s"; t?: string; m?: string };
const done: Ev = { k: "complete", lastRole: "human_agent" };
const c = (t: string, m?: string): Ev => ({ k: "c", t, m });
const s = (t: string, m?: string): Ev => ({ k: "s", t, m });
const AUD = (): Ev => ({ k: "c", t: "[audio]", m: "audio" });
const SAUD = (): Ev => ({ k: "s", t: "[audio]", m: "audio" });

interface Case { id: string; stage: string; expected: "customer" | "team" | "verify"; knownMismatch?: string; tl: Ev[] }
const CASES: Case[] = [
  { id: "01 Strada/Fox (áudios sem resposta)", stage: "decision_negotiation", expected: "team", tl: [done, AUD(), AUD(), s("blz")] },
  { id: "02 biel (tabela e silêncio)", stage: "decision_negotiation", expected: "customer", tl: [done, s("vou te encaminha tabela de precos"), s("tenho parcelas a partir de 80x384"), s("tenta me fala por favor quanto de parcela vc que paga por mes ?"), c("🎤 Isso beleza, eu vou deixar o seguinte. Desculpem."), c("🎤 Deixem pra semana que vem. Eu vejo vocês."), s("BOA TARDE VAMOS AGILIZA SEU CONSORCIO ? ABRI SEU PLANO")] },
  { id: "03 carta de 15 mil (foi à loja?)", stage: "decision_negotiation", expected: "customer", tl: [done] },
  { id: "04 Romario (consórcio 40 mil)", stage: "decision_negotiation", expected: "customer", tl: [done, AUD(), s("consórcio 40.000   61 x 575,95  plano parcela reduzida ate a contemplação"), s("tenho esse plano na parcela aproximada que me passou"), s("esse ficaria bom pra você ?")] },
  { id: "05 financiamento negado + carta", stage: "documentation", expected: "customer", tl: [done, c("Ok"), s("Boa tarde"), s("me chamo Marina irei continuar com seu atendimento"), s("temos cartas já contempladas com entrada de 8.900"), c("E as parcelas fica dê quantos"), s("*MT | Carta Contemplada YAMAHA* Entrada: R$ 8.100,00 Parcelas: 56x R$ 535,00")] },
  { id: "06 financiamento negado + 3 opções", stage: "documentation", expected: "customer", tl: [done, c("123.456.789-00"), s("O banco não aprovou dessa vez, mas pode ser algo pontual"), c("Qual"), s("temos outras opções de você adquiri a sua moto no consórcio"), s("temos também o plano libera cred que com 12 parcela pagas você já pega a moto"), s("qual dessas opções fica melhor pra você ?")] },
  { id: "07 moto de entrada (avaliação)", stage: "decision_negotiation", expected: "team", knownMismatch: "caso misto (cliente leva a moto, a loja marca o dia): só o vendedor sabe; a regra vê pergunta/proposta e marca 'cliente'", tl: [done, c("Uma CG fan 160 24/25 está com 20.000 km"), c("Sim"), s("tem que trazer na loja para avaliarmos"), s("ela ta quitada ?"), s("🅼🆃 | Carta Contemplada Yamaha Crédito: R$ 39.286,49 Entrada: R$ 20.614,46 De 1 Até 46 R$ 640,00")] },
  { id: "08 Factor 150 (EUA)", stage: "decision_negotiation", expected: "customer", tl: [done, s("Bom dia vamos da serguimento no seu consórcio ?"), s("Vi que você confirmou a Factor 150 DX pelo consórcio, parcela de 845,26 em 35x. Prefere fechar nessa condição ou 36x 822,76 que te interessa ?")] },
  { id: "09 imóvel R$400/mês", stage: "decision_negotiation", expected: "customer", tl: [done, s("BOA TARDE"), s("voce fechando sua carta de credito garate grande promocao que estou tendo"), s("Boa tarde vamos fecha a compra da sua carta de crédito ?"), s("Oi, tudo bem? Vi que você quer o consórcio de imóvel aí, com R$400/mês e sem lance. Prefere crédito de R$100 mil ou de R$150 mil ?")] },
  { id: "10 boleto vencido", stage: "decision_negotiation", expected: "verify", tl: [done, AUD(), s("conseguiu efetuar o pagamento do boleto"), s("o vencimento era pra ontem"), s("ainda tem interesse em seguir com o consórcio ?")] },
  { id: "11 áudios e pagamento do dia 5", stage: "decision_negotiation", expected: "customer", tl: [done, AUD(), SAUD(), AUD(), SAUD(), c("🎤 Não conseguiu o dinheiro não, só o dia 5 mesmo, o pagamento"), s("BOA TARDE VAMOS DA SEGUIMENTO NO SEU CONSORCIO ?")] },
  { id: "12 carta de carro (anúncio)", stage: "decision_negotiation", expected: "customer", tl: [done, s("qual modelo de carro voce ta procurando ?"), s("*MT | Carta Contemplada Yamaha* Crédito: R$ 71.519,00 Entrada: R$ 30.698,00 De 1 Até 27 R$ 1.963,00"), c("[Cliente veio de um anúncio: Simule seu consórcio de automóvel]"), s("conseguiu analisa a carta que te enviei ?")] },
  { id: "13 entrada e troca (cliente respondeu hoje)", stage: "compatible_letter_search", expected: "team", tl: [done, s("Te aviso"), SAUD(), SAUD(), c("Rapaz faltaram me bater se eu fizesse essa moto nesse valor"), c("Se baixar a entrada ate da pra conversar")] },
  { id: "14 scooter à vista", stage: "negotiation", expected: "customer", tl: [done, s("Voltando aqui sobre a X13 — consigo fechar à vista por R$ 12.500. Ainda tem interesse em seguir com ela?")] },
];

type St = { waiting_on: string; next_action: string };
function simulate(tl: Ev[], stage: string, mode: "v1" | "v2"): St {
  let st: St = { waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION };
  const facts = (): OppFacts => ({ status: "open", stage, ...st, frozen_until: null, waiting_on_until: null });
  for (const e of tl) {
    if (e.k === "complete") {
      const d = decideAttendanceCompleted({ opportunity: facts(), completedTypes: ["return_customer"], humanRepliedAfterTaskCreated: true, otherOpenTasks: 0, lastMessageRole: mode === "v2" ? e.lastRole : undefined, today: "2026-11-14" });
      if (d.action === "set_customer") st = { waiting_on: d.waiting_on, next_action: d.next_action };
    } else if (e.k === "c") {
      const d = mode === "v2" ? decideCustomerReplied({ opportunity: facts(), reply: classifyCustomerReply(e.t, e.m), today: "2026-11-14" })
        : decideCustomerReplied({ opportunity: facts(), substantive: !/^(ok|blz)$/i.test(e.t ?? "") && !(e.t ?? "").startsWith("[Cliente veio"), today: "2026-11-14" });
      if (d.action === "set_team") st = { waiting_on: d.waiting_on, next_action: d.next_action };
    } else if (mode === "v2") {
      const d = decideSellerMessage({ opportunity: facts(), kind: classifySellerMessage(e.t, e.m), blockingOpenTasks: 0, today: "2026-11-14" });
      if (d.action !== "keep") st = { waiting_on: d.waiting_on, next_action: d.next_action };
    }
  }
  return st;
}

describe("simulação contra os 14 casos reais da Onda 0", () => {
  const evaluable = CASES.filter((x) => x.expected !== "verify");
  const result = (mode: "v1" | "v2") => evaluable.map((x) => ({ id: x.id, got: simulate(x.tl, x.stage, mode).waiting_on, ok: simulate(x.tl, x.stage, mode).waiting_on === x.expected }));

  it("regra do #97 (baseline): erra os casos em que o cliente respondeu e o vendedor fez proposta", () => {
    const wrong = result("v1").filter((r) => !r.ok).map((r) => r.id);
    expect(wrong).toEqual(expect.arrayContaining(["02 biel (tabela e silêncio)", "04 Romario (consórcio 40 mil)", "05 financiamento negado + carta", "06 financiamento negado + 3 opções", "11 áudios e pagamento do dia 5"]));
    expect(wrong.length).toBeGreaterThanOrEqual(5);
  });
  it.each(evaluable.filter((x) => !x.knownMismatch))("v2 acerta: $id => $expected", (x) => {
    expect(simulate(x.tl, x.stage, "v2").waiting_on).toBe(x.expected);
  });
  it("único divergente conhecido (caso misto): a regra marca 'cliente', o vendedor corrige à mão e a edição humana nunca é sobrescrita", () => {
    const x = CASES.find((k) => k.knownMismatch)!;
    expect(simulate(x.tl, x.stage, "v2").waiting_on).toBe("customer");
    expect(x.knownMismatch).toBeTruthy();
  });
  it("placar: v2 acerta 12 dos 13 casos avaliáveis (o 14º depende de conferir o boleto)", () => {
    const r = result("v2"); expect(r.filter((x) => x.ok)).toHaveLength(12); expect(r.filter((x) => !x.ok).map((x) => x.id)).toEqual(["07 moto de entrada (avaliação)"]);
    expect(result("v1").filter((x) => x.ok).length).toBeLessThan(12);
  });
});

describe("cenários de áudio e múltiplas mensagens", () => {
  it("só áudios dos dois lados: o áudio do cliente devolve à equipe e o do vendedor não muda nada", () => {
    expect(simulate([done, AUD(), SAUD(), AUD(), SAUD()], "decision_negotiation", "v2")).toEqual(REPLIED);
  });
  it("rajada do vendedor: proposta + 'vou verificar o resto' termina com a bola da equipe", () => {
    const st = simulate([done, c("Qual o valor?"), s("entrada R$ 8.000, 56x R$ 535"), s("vou verificar se tem opção menor")], "decision_negotiation", "v2");
    expect(st).toEqual({ waiting_on: "team", next_action: SELLER_PROMISED_NEXT_ACTION });
  });
  it("promessa seguida de proposta volta para o cliente", () => {
    const st = simulate([done, c("Qual o valor?"), s("já te passo"), s("entrada R$ 8.000, 56x R$ 535")], "decision_negotiation", "v2");
    expect(st).toEqual(AWAIT);
  });
  it("vários 'ok' do cliente depois da proposta não devolvem a bola; uma pergunta depois deles sim", () => {
    expect(simulate([done, s("entrada R$ 8.000, 56x R$ 535"), c("ok"), c("blz"), c("👍")], "decision_negotiation", "v2")).toEqual(AWAIT);
    expect(simulate([done, s("entrada R$ 8.000, 56x R$ 535"), c("ok"), c("e se for 48x?")], "decision_negotiation", "v2")).toEqual(REPLIED);
  });
  it("'Não' do cliente: a bola vai para a equipe com texto próprio e a proposta seguinte do vendedor NÃO a devolve ao cliente", () => {
    const st = simulate([done, s("entrada R$ 8.000, 56x R$ 535"), c("Não"), s("e se eu baixar a entrada para R$ 6.000?")], "decision_negotiation", "v2");
    expect(st).toEqual({ waiting_on: "team", next_action: CUSTOMER_DECLINED_NEXT_ACTION });
  });
  it("mensagem longa do vendedor sem proposta nem pergunta ('não trivial') NÃO marca aguardando cliente", () => {
    expect(simulate([done, c("Qual o valor?"), s("Estamos com várias opções disponíveis nesta semana na loja, passe quando puder")], "decision_negotiation", "v2")).toEqual(REPLIED);
  });
  it("cliente esperando a equipe quando a tarefa é concluída: não vira aguardando cliente", () => {
    expect(simulate([{ k: "complete", lastRole: "contact" }], "decision_negotiation", "v2")).toEqual({ waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION });
  });
});
