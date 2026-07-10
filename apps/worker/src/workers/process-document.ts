import { Worker } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { ProcessDocumentJobData } from "@aula-agente/queue";
import { getRedisConnection } from "@aula-agente/queue";
import { getAdminClient, getDocumentById, updateDocument, insertChunks } from "@aula-agente/database";
import { resolveApiKey } from "../lib/vault";
import { chunkText } from "../embeddings/chunker";
import { generateEmbeddings } from "../embeddings/embedder";

async function extractTextFromUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch document: ${response.status}`);
  }

  // For simplicity, treat all as plain text
  // In production, use pdf-parse for PDFs, mammoth for DOCX, etc.
  const text = await response.text();
  return text;
}

export function startProcessDocumentWorker() {
  const worker = new Worker<ProcessDocumentJobData>(
    QUEUE_NAMES.PROCESS_DOCUMENT,
    async (job) => {
      const { documentId, organizationId, agentId } = job.data;
      const db = getAdminClient();

      try {
        // Load document
        const document = await getDocumentById(db, documentId);

        // Extract text
        const text = await extractTextFromUrl(document.file_url);

        if (!text.trim()) {
          await updateDocument(db, documentId, {
            status: "error",
            error_message: "No text content extracted from document",
          });
          return;
        }

        // Chunk text
        const chunks = chunkText(text);

        // Resolve API key for embeddings (always uses OpenAI for embeddings)
        const apiKey = await resolveApiKey(organizationId, "openai");

        // Generate embeddings
        const embeddings = await generateEmbeddings(
          chunks.map((c) => c.content),
          apiKey
        );

        // Insert chunks with embeddings
        await insertChunks(
          db,
          chunks.map((chunk, i) => ({
            document_id: documentId,
            organization_id: organizationId,
            content: chunk.content,
            metadata: chunk.metadata,
            embedding: embeddings[i],
            chunk_index: chunk.metadata.chunk_index,
          }))
        );

        // Update document status
        await updateDocument(db, documentId, {
          status: "ready",
          chunk_count: chunks.length,
        });

        console.log(`Processed document ${documentId}: ${chunks.length} chunks`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await updateDocument(db, documentId, {
          status: "error",
          error_message: message,
        });
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`Document job ${job?.id} failed:`, err.message);
  });

  console.log("Process-document worker started");
  return worker;
}
