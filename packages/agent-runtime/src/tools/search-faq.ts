import { tool, type Tool } from "ai";
import { z } from "zod";
import { getAdminClient, getFaqsByAgent } from "@aula-agente/database";
import type { KnowledgeFaq } from "@aula-agente/shared";

// Strips accents so "endereço" matches "endereco" and typo'd/informal
// customer phrasing (WhatsApp text rarely carries accents correctly)
// doesn't silently fail to match an FAQ that uses them correctly.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Real production case: a customer asked "Essa loja e d qui cidade" — the
// model reformulated this into a search query, but the matching FAQ's text
// ("A Moto e Trilha fica em Posse, Goiás...") never literally contained
// "cidade", "loja", or "endereço", so word-overlap scoring came in under
// the old 0.3 threshold and the search returned nothing, even though the
// right answer was sitting right there. Lowering the threshold to 0.2
// keeps enough words a genuine near-miss doesn't get thrown away, while
// still filtering out reformulated queries that share only one stray word
// with an unrelated FAQ.
const MATCH_THRESHOLD = 0.2;

export function findRelevantFaqs(query: string, faqs: KnowledgeFaq[]): KnowledgeFaq[] {
  const queryWords = normalize(query)
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (queryWords.length === 0) return [];

  const scored = faqs.map((faq) => {
    const faqText = normalize(`${faq.question} ${faq.answer}`);
    const matchCount = queryWords.filter((word) => faqText.includes(word)).length;
    return { faq, score: matchCount / queryWords.length };
  });

  return scored
    .filter((s) => s.score > MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.faq);
}

export function createSearchFaqTool(agentId: string): Tool {
  return tool({
    description: "Search the FAQ database for common questions and answers. Use this when the user asks a question that might have a standard answer.",
    inputSchema: z.object({
      query: z.string().describe("The question to search for in the FAQ database"),
    }),
    execute: async ({ query }) => {
      const db = getAdminClient();
      const faqs = await getFaqsByAgent(db, agentId);

      if (faqs.length === 0) {
        return "No FAQs configured for this agent.";
      }

      const relevant = findRelevantFaqs(query, faqs);

      if (relevant.length === 0) {
        return "No matching FAQs found for this query.";
      }

      return relevant
        .map((faq, i) => `[FAQ ${i + 1}]\nQ: ${faq.question}\nA: ${faq.answer}`)
        .join("\n\n---\n\n");
    },
  });
}
