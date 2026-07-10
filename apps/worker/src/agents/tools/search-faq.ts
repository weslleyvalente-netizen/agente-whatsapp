import { tool } from "ai";
import { z } from "zod";
import { getAdminClient, getFaqsByAgent } from "@aula-agente/database";

export function createSearchFaqTool(agentId: string) {
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

      // Simple keyword matching
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

      const scored = faqs.map((faq) => {
        const faqText = `${faq.question} ${faq.answer}`.toLowerCase();
        const matchCount = queryWords.filter((word) => faqText.includes(word)).length;
        return { faq, score: matchCount / queryWords.length };
      });

      const relevant = scored
        .filter((s) => s.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (relevant.length === 0) {
        return "No matching FAQs found for this query.";
      }

      return relevant
        .map((r, i) => `[FAQ ${i + 1}]\nQ: ${r.faq.question}\nA: ${r.faq.answer}`)
        .join("\n\n---\n\n");
    },
  });
}
