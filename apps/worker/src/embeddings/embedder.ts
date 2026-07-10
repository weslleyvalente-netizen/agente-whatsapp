import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const BATCH_SIZE = 100;

export async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
  const openai = createOpenAI({ apiKey });

  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text,
  });

  return embedding;
}

export async function generateEmbeddings(
  texts: string[],
  apiKey: string
): Promise<number[][]> {
  const openai = createOpenAI({ apiKey });
  const allEmbeddings: number[][] = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const { embeddings } = await embedMany({
      model: openai.embedding("text-embedding-3-small"),
      values: batch,
    });

    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}
