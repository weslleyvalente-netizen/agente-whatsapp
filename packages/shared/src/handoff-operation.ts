// Produto (operação) do card criado no encaminhamento para humano. Função pura, sem IA.
// Prioridade (decisão do dono 25/11): 1) intenção explícita do cliente; 2) contexto recente da conversa; 3) resumo do encaminhamento;
// 4) anúncio de origem — só como evidência complementar (nunca decide sozinho). Sem evidência suficiente => null: o card fica
// "a confirmar" (operation_is_default), em vez de assumir venda de veículo. Atendimento administrativo nunca vira produto.
import type { Operation } from "./types/opportunity.js";

export interface HandoffOperationMessage { role: string; content: string | null }
export interface HandoffOperationInput {
  /** Mensagens recentes da conversa, em ordem cronológica (cliente = 'contact'). */
  messages: HandoffOperationMessage[];
  resumo: string | null;
  /** Título + texto do último anúncio de origem (lead_ad_touches), se houver. */
  adText: string | null;
}
export interface HandoffOperationResult {
  operation: Operation | null;
  source: "customer" | "context" | "resumo" | null;
  confidence: "high" | "medium" | "none";
  evidence: string;
  administrative: boolean;
  /** Produto sugerido só pelo anúncio (informativo; não decide). */
  adHint: Operation | null;
}

type Finance = Exclude<Operation, "vehicle_sale">;
const FINANCE: Array<[Finance, RegExp]> = [
  ["contemplated_letter", /cartas?\s+contemplad|contemplad[ao]s?\b|cartas?\s+de\s+cr[eé]dito|\bcartas?\b/],
  ["consortium", /cons[oó]rcio/],
  ["libera_cred", /libera\s?cred/],
  ["financing", /financ(iar|iamento|ia\b|io\b)/],
];
const LETTER_EXPLICIT = /cartas?\s+contemplad|contemplad[ao]s?\b/;
const VEHICLE_CUSTOMER = /(à vista|a vista|\b0\s?km\b|seminov[ao]|usad[ao]|quanto (custa|t[aá]|est[aá]|sai)|pre[cç]o d[aoe]|valor d[aoe] (moto|carro|bike)|test.?drive|trocar de moto|tem moto)/;
const VEHICLE_RESUMO = /(quer comprar|compra d[ae] (moto|carro|bike)|à vista|pre[cç]o d[ae]|valor d[ae] (moto|carro)|test.?drive|seminov[ao]|\b0\s?km\b)/;
const ADMIN = /(boleto|segunda via|2ª via|comprovante|parcela atrasada|detran|transfer[eê]ncia de|\brevis[aã]o|oficina|troca de [oó]leo|assembleia|minha cota)/;
const INTENT = /(quer|deseja|procura|busca|interess|prefere|pergunt|pediu)/;
const AD_PREFIX = /^\s*\[cliente veio de um an[uú]ncio:[\s\S]*?\]\s*/;

const norm = (t: string | null | undefined) => (t ?? "").toLowerCase().replace(AD_PREFIX, "").trim();
const finance = (t: string): Finance[] => FINANCE.filter(([, re]) => re.test(t)).map(([op]) => op);
const around = (t: string, re: RegExp) => { const m = re.exec(t); if (!m) return t.slice(0, 80); return t.slice(Math.max(0, m.index - 30), m.index + 50).trim(); };
const reOf = (op: Operation) => (op === "vehicle_sale" ? VEHICLE_CUSTOMER : FINANCE.find(([o]) => o === op)![1]);

/** Produto único de um texto (financeiros têm prioridade sobre compra de veículo; 2+ financeiros = ambíguo). */
function single(t: string, vehicle: RegExp | null): Operation | "ambiguous" | null {
  const f = finance(t);
  if (f.length > 1) return "ambiguous";
  if (f.length === 1) return f[0];
  if (vehicle && vehicle.test(t)) return "vehicle_sale";
  return null;
}

export function inferHandoffOperation(input: HandoffOperationInput): HandoffOperationResult {
  const customer = input.messages.filter((m) => m.role === "contact").map((m) => norm(m.content)).filter(Boolean);
  const ours = input.messages.filter((m) => m.role === "agent" || m.role === "human_agent").map((m) => norm(m.content)).filter(Boolean);
  const resumo = norm(input.resumo);
  const ad = norm(input.adText);
  const adOne = ad ? single(ad, null) : null;
  const adHint = adOne && adOne !== "ambiguous" ? adOne : null;
  const none = (administrative: boolean): HandoffOperationResult => ({ operation: null, source: null, confidence: "none", evidence: "", administrative, adHint });

  // Administrativo (boleto, segunda via, documento no Detran, revisão...) nunca abre produto.
  if (customer.slice(-6).some((t) => ADMIN.test(t)) || ADMIN.test(resumo)) return none(true);

  // 1) Cliente: a fala mais recente com produto decide; se ela for ambígua (2 produtos), passa para os próximos níveis.
  for (const t of [...customer].reverse().slice(0, 10)) {
    const p = single(t, VEHICLE_CUSTOMER);
    if (p === "ambiguous") break;
    if (p) {
      const medium = p === "contemplated_letter" && !LETTER_EXPLICIT.test(t);
      return { operation: p, source: "customer", confidence: medium ? "medium" : "high", evidence: around(t, reOf(p)), administrative: false, adHint };
    }
  }
  // 2) Contexto recente: o que as nossas últimas mensagens trataram, ignorando a IA listando opções (2+ produtos na mesma mensagem).
  for (const t of [...ours].reverse().slice(0, 4)) {
    const p = single(t, null);
    if (p && p !== "ambiguous") return { operation: p, source: "context", confidence: "medium", evidence: around(t, reOf(p)), administrative: false, adHint };
  }
  // 3) Resumo: produto único, ou o que vem depois do verbo de intenção ("quer saber da carta...") quando o resumo cita o anúncio.
  if (resumo) {
    let p = single(resumo, VEHICLE_RESUMO);
    let text = resumo;
    if (p === "ambiguous") {
      const m = INTENT.exec(resumo);
      text = m ? resumo.slice(m.index) : "";
      p = text ? single(text, VEHICLE_RESUMO) : null;
    }
    if (p && p !== "ambiguous") return { operation: p, source: "resumo", confidence: "medium", evidence: around(text, p === "vehicle_sale" ? VEHICLE_RESUMO : reOf(p)), administrative: false, adHint };
  }
  // 4) Anúncio sozinho não decide.
  return none(false);
}
