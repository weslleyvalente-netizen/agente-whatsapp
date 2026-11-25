// Produto do card de encaminhamento (decisão do dono 25/11): intenção explícita do cliente > contexto recente > resumo > anúncio.
// O anúncio é evidência complementar: sozinho não decide. Sem evidência suficiente => null ("a confirmar"), nunca venda de veículo por padrão.
import { describe, expect, it } from "vitest";
import { inferHandoffOperation, type HandoffOperationInput } from "./handoff-operation.js";

const msg = (role: "contact" | "agent" | "human_agent", content: string) => ({ role, content });
const RUBEN_AD = "Seu próximo carro — O seu próximo carro pode vir por consórcio ou por carta contemplada. Cada um tem regras diferentes.";
const base = (over: Partial<HandoffOperationInput> = {}): HandoffOperationInput => ({ messages: [], resumo: null, adText: null, ...over });

describe("inferHandoffOperation", () => {
  it("caso Ruben: cliente pede as cartas contempladas => carta contemplada, pela fala do cliente (não pelo anúncio)", () => {
    const r = inferHandoffOperation(base({
      messages: [msg("contact", `[Cliente veio de um anúncio: ${RUBEN_AD}]\nQuais cartas contempladas vocês têm hoje?`)],
      resumo: "Cliente veio de anúncio de carro (consórcio/carta contemplada) e quer saber quais cartas contempladas estão disponíveis hoje.",
      adText: RUBEN_AD,
    }));
    expect(r).toMatchObject({ operation: "contemplated_letter", source: "customer", confidence: "high" });
    expect(r.evidence).toMatch(/cartas contempladas/i);
  });

  it("o texto do anúncio colado na mensagem não conta como fala do cliente", () => {
    const r = inferHandoffOperation(base({ messages: [msg("contact", `[Cliente veio de um anúncio: ${RUBEN_AD}]\nOi, bom dia`)], adText: RUBEN_AD }));
    expect(r.operation).toBeNull();
  });

  it("intenção explícita por produto (consórcio, financiamento, Libera Cred, compra de moto)", () => {
    const one = (t: string) => inferHandoffOperation(base({ messages: [msg("contact", t)] })).operation;
    expect(one("quero fazer um consórcio de moto")).toBe("consortium");
    expect(one("dá pra financiar a Fazer em 48x?")).toBe("financing");
    expect(one("como funciona o liberacred?")).toBe("libera_cred");
    expect(one("quanto tá a Titan 160 à vista?")).toBe("vehicle_sale");
    expect(one("tem moto seminova?")).toBe("vehicle_sale");
  });

  it("a fala mais recente do cliente vence; mensagem com dois produtos não decide sozinha", () => {
    expect(inferHandoffOperation(base({ messages: [msg("contact", "queria financiar"), msg("agent", "certo"), msg("contact", "pensando melhor, quero consórcio")] })).operation).toBe("consortium");
    const r = inferHandoffOperation(base({ messages: [msg("contact", "é melhor consórcio ou financiamento?")], resumo: "Cliente quer comparar; prefere financiamento." }));
    expect(r).toMatchObject({ operation: "financing", source: "resumo" });
  });

  it("'carta de crédito' sem 'contemplada' => carta, mas confiança média (pode ser consórcio)", () => {
    expect(inferHandoffOperation(base({ messages: [msg("contact", "vc tem carta de crédito pra comprar carro?")] }))).toMatchObject({ operation: "contemplated_letter", confidence: "medium" });
  });

  it("contexto recente: o que a conversa tratou vale, mas a IA listando opções não", () => {
    const ctx = inferHandoffOperation(base({ messages: [msg("contact", "carro"), msg("agent", "Pra carta contemplada de carro, a entrada e o crédito variam."), msg("contact", "uns 50 mil")] }));
    expect(ctx).toMatchObject({ operation: "contemplated_letter", source: "context", confidence: "medium" });
    const menu = inferHandoffOperation(base({ messages: [msg("agent", "Posso te ajudar com moto, consórcio, financiamento ou o LiberaCred."), msg("contact", "isso")] }));
    expect(menu.operation).toBeNull();
  });

  it("resumo: vale o produto que o cliente QUER, mesmo quando o resumo cita o anúncio com dois produtos", () => {
    expect(inferHandoffOperation(base({ resumo: "Veio do anúncio de consórcio/carta contemplada e quer saber como funciona o consórcio." })).operation).toBe("consortium");
    expect(inferHandoffOperation(base({ resumo: "Veio do anúncio de consórcio/carta contemplada para carro." })).operation).toBeNull();
  });

  it("anúncio sozinho não decide (evidência complementar): fica a confirmar", () => {
    const r = inferHandoffOperation(base({ adText: "Simule seu consórcio de automóvel", messages: [msg("contact", "oi")] }));
    expect(r).toMatchObject({ operation: null, source: null, confidence: "none" });
    expect(r.adHint).toBe("consortium");
  });

  it("administrativo (boleto, segunda via, documento) nunca vira produto", () => {
    const r = inferHandoffOperation(base({ messages: [msg("contact", "preciso da segunda via do boleto do consórcio")], resumo: "Cliente pediu segunda via de boleto." }));
    expect(r.operation).toBeNull();
    expect(r.administrative).toBe(true);
  });

  it("falsos positivos reais de administrativo (25/11): 'previsão' não é 'revisão'; 'sem garantia' em venda de usada", () => {
    expect(inferHandoffOperation(base({ resumo: "Cliente procura Titan 2026 à vista. Precisa confirmar se há previsão de chegada da 2027." }))).toMatchObject({ administrative: false, operation: "vehicle_sale" });
    expect(inferHandoffOperation(base({ messages: [msg("contact", "tem moto usada? pode ser sem garantia, repasse")] }))).toMatchObject({ administrative: false, operation: "vehicle_sale" });
  });

  it("sem nada => a confirmar (null), nunca venda de veículo por padrão", () => {
    expect(inferHandoffOperation(base({ messages: [msg("contact", "bom dia"), msg("contact", "aonde fica a loja")] }))).toMatchObject({ operation: null, confidence: "none" });
  });

  // Revisão do dono (25/11) no GitHub: casos adicionais.
  it("negação: 'não quero financiamento' não vira financiamento; com alternativa, vale a alternativa", () => {
    const one = (t: string) => inferHandoffOperation(base({ messages: [msg("contact", t)] }));
    expect(one("não quero financiamento").operation).toBeNull();
    expect(one("nao quero financiar, quero consórcio").operation).toBe("consortium");
    expect(one("não tenho interesse em carta contemplada, quero comprar a moto à vista").operation).toBe("vehicle_sale");
  });

  it("cliente que JÁ tem carta de crédito não está comprando carta: quer usar no veículo (ou fica a confirmar)", () => {
    const one = (t: string) => inferHandoffOperation(base({ messages: [msg("contact", t)] })).operation;
    expect(one("já tenho uma carta de crédito contemplada, quero usar pra comprar uma moto seminova")).toBe("vehicle_sale");
    expect(one("minha carta foi contemplada, como faço pra usar?")).not.toBe("contemplated_letter");
  });

  it("mudança de intenção: a fala mais recente vence, mesmo depois de vários dias falando de outro produto", () => {
    const r = inferHandoffOperation(base({ messages: [
      msg("contact", "quero uma carta contemplada de 60 mil"), msg("human_agent", "tenho essa carta contemplada aqui"),
      msg("contact", "achei caro a entrada"), msg("contact", "na verdade prefiro financiar a moto")] }));
    expect(r).toMatchObject({ operation: "financing", source: "customer" });
  });

  it("atendimento misto: assunto administrativo + nova compra => vale a compra (não descarta a venda)", () => {
    const r = inferHandoffOperation(base({ messages: [msg("contact", "paguei o boleto do consórcio ontem"), msg("contact", "e queria ver uma moto nova pra comprar à vista")] }));
    expect(r).toMatchObject({ operation: "vehicle_sale", administrative: false });
    expect(r.mixedAdministrative).toBe(true);
  });

  it("consórcio convencional × carta contemplada", () => {
    const one = (t: string) => inferHandoffOperation(base({ messages: [msg("contact", t)] })).operation;
    expect(one("quero entrar num grupo de consórcio de moto")).toBe("consortium");
    expect(one("quero uma carta já contemplada, sem esperar sorteio")).toBe("contemplated_letter");
    expect(one("qual o valor da carta de crédito do consórcio pra moto?")).toBe("consortium");
    expect(one("quero consórcio, não carta contemplada")).toBe("consortium");
  });

  it("mensagens antigas que não representam mais a intenção atual: só as recentes contam quando há fala nova", () => {
    const r = inferHandoffOperation(base({ messages: [msg("contact", "quero consórcio"), ...Array.from({ length: 12 }, () => msg("contact", "ok")), msg("contact", "e aí, tem novidade?")] }));
    expect(r.operation).toBeNull(); // a menção a consórcio ficou para trás (fora das 10 últimas falas do cliente)
  });

  it("resumo com valor de uma moto específica => venda de veículo (divergência do levantamento, card dee90168)", () => {
    expect(inferHandoffOperation(base({ resumo: "Cliente mandou um vídeo perguntando o valor de uma moto específica mostrada nele." })).operation).toBe("vehicle_sale");
  });
});
