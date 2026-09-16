import { describe, it, expect } from "vitest";
import { findRelevantFaqs } from "./search-faq.js";
import type { KnowledgeFaq } from "@aula-agente/shared";

function faq(question: string, answer: string): KnowledgeFaq {
  return {
    id: "id",
    agent_id: "agent",
    organization_id: "org",
    question,
    answer,
    is_active: true,
    created_at: "",
    updated_at: "",
  };
}

describe("findRelevantFaqs", () => {
  // Real production case: a customer asked "Essa loja e d qui cidade"
  // (garbled). The model's reformulated search query didn't share enough
  // literal words with the FAQ's answer text ("A Moto e Trilha fica em
  // Posse, Goiás...") to clear the old 0.3 threshold, so the search
  // returned nothing even though the FAQ answered the question directly.
  it("finds the store-location FAQ for a query about city/address", () => {
    const faqs = [
      faq(
        "Onde fica a loja? Qual a cidade e endereço da Moto e Trilha?",
        "Nossa loja fica em Posse, Goiás. O endereço é Avenida JK, Quadra 03, Lote 22."
      ),
      faq("Vocês fazem financiamento de moto?", "Sim, trabalhamos com financiamento de motos."),
    ];

    const result = findRelevantFaqs("qual a cidade da loja", faqs);

    expect(result).toHaveLength(1);
    expect(result[0].question).toContain("Onde fica a loja");
  });

  it("matches accented FAQ text against an unaccented query", () => {
    const faqs = [faq("Qual o endereço?", "Ficamos na Avenida JK, em Posse, Goiás.")];

    const result = findRelevantFaqs("qual o endereco da loja", faqs);

    expect(result).toHaveLength(1);
  });

  it("returns an empty array when nothing matches well enough", () => {
    const faqs = [faq("Vocês fazem financiamento de moto?", "Sim, trabalhamos com financiamento de motos.")];

    expect(findRelevantFaqs("qual a cor do céu", faqs)).toEqual([]);
  });

  it("returns at most 3 FAQs, ranked by score", () => {
    const faqs = [
      faq("Endereço da loja de motos", "Ficamos em Posse, Goiás."),
      faq("Endereço", "Posse, Goiás, endereço fixo."),
      faq("Cidade e endereço", "Cidade: Posse. Endereço: Avenida JK."),
      faq("Financiamento", "Trabalhamos com financiamento."),
    ];

    const result = findRelevantFaqs("cidade endereço loja", faqs);

    expect(result.length).toBeLessThanOrEqual(3);
  });
});
