import { tool, embed } from "ai";
import { z } from "zod";
import { getAdminClient, searchKnowledgeChunks } from "@aula-agente/database";
import { createOpenAI } from "@ai-sdk/openai";

export function createSearchKnowledgeTool(organizationId: string, agentId: string, apiKey: string) {
  return tool({
    description: "Search the knowledge base for relevant information about a topic. Use this to find answers from uploaded documents.",
    inputSchema: z.object({
      query: z.string().describe("The search query to find relevant information"),
    }),
    execute: async ({ query }) => {
      const openai = createOpenAI({ apiKey });

      // Generate embedding for the query
      const { embedding } = await embed({
        model: openai.embedding("text-embedding-3-small"),
        value: query,
      });

      // Search in pgvector
      const db = getAdminClient();
      const results = await searchKnowledgeChunks(db, organizationId, agentId, embedding, 5);

      if (results.length === 0) {
        return "No relevant information found in the knowledge base.";
      }

      return results
        .map((r, i) => `[${i + 1}] (relevance: ${(r.similarity * 100).toFixed(1)}%)\n${r.content}`)
        .join("\n\n---\n\n");
    },
  });
}
