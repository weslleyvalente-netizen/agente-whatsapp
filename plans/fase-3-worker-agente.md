# Fase 3: Worker & Agente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar o Worker BullMQ com processamento de mensagens (AI SDK + tools), pipeline de RAG (chunking + embeddings + pgvector), envio de mensagens via Evolution API, lock por conversa, e vault integration para API keys.

**Architecture:** Worker roda como processo independente consumindo 4 filas BullMQ. process-message adquire lock Redis por conversa, resolve API key do tenant via vault, e chama AI SDK com tools registradas dinamicamente. process-document faz chunking e gera embeddings.

**Tech Stack:** BullMQ, Vercel AI SDK, OpenAI SDK, ioredis, Supabase JS

**Depends on:** Fase 1 (packages), Fase 2 (API server, services)

---

### Task 1: Redis Lock para Processamento Sequencial por Conversa

**Files:**
- Create: `apps/worker/src/lib/lock.ts`

- [ ] **Step 1: Criar lock.ts**

Criar `apps/worker/src/lib/lock.ts`:
```typescript
import { getRedisConnection } from "@aula-agente/queue";

const LOCK_PREFIX = "lock:conversation:";
const LOCK_TTL_MS = 60_000; // 60 seconds max lock
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 20; // 10 seconds max wait

export async function acquireConversationLock(conversationId: string): Promise<string | null> {
  const redis = getRedisConnection();
  const lockKey = `${LOCK_PREFIX}${conversationId}`;
  const lockValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let i = 0; i < MAX_RETRIES; i++) {
    const result = await redis.set(lockKey, lockValue, "PX", LOCK_TTL_MS, "NX");
    if (result === "OK") {
      return lockValue;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  return null; // Failed to acquire lock
}

export async function releaseConversationLock(conversationId: string, lockValue: string) {
  const redis = getRedisConnection();
  const lockKey = `${LOCK_PREFIX}${conversationId}`;

  // Only release if we still hold the lock (Lua script for atomicity)
  const luaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  await redis.call("EVAL", luaScript, "1", lockKey, lockValue);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/lib/lock.ts
git commit -m "feat(worker): add Redis conversation lock with TTL and retry"
```

---

### Task 2: Vault Integration — Resolver API Keys do Tenant

**Files:**
- Create: `apps/worker/src/lib/vault.ts`

- [ ] **Step 1: Criar vault.ts**

Criar `apps/worker/src/lib/vault.ts`:
```typescript
import { getAdminClient } from "@aula-agente/database";
import type { LLMProvider } from "@aula-agente/shared";

// Cache for resolved keys (TTL: 5 minutes)
const keyCache = new Map<string, { key: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const ENV_FALLBACKS: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_AI_API_KEY",
};

export async function resolveApiKey(
  organizationId: string,
  provider: LLMProvider
): Promise<string> {
  const cacheKey = `${organizationId}:${provider}`;

  // Check cache
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  // Try organization secrets
  const db = getAdminClient();
  const { data, error } = await db
    .from("organization_secrets")
    .select("encrypted_key")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();

  if (!error && data?.encrypted_key) {
    keyCache.set(cacheKey, {
      key: data.encrypted_key,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return data.encrypted_key;
  }

  // Fallback to global env var
  const envKey = process.env[ENV_FALLBACKS[provider]];
  if (!envKey) {
    throw new Error(
      `No API key found for provider "${provider}" in organization "${organizationId}" or environment`
    );
  }

  return envKey;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/lib/vault.ts
git commit -m "feat(worker): add vault integration for tenant API key resolution"
```

---

### Task 3: Tool — Search Knowledge (RAG)

**Files:**
- Create: `apps/worker/src/agents/tools/search-knowledge.ts`

- [ ] **Step 1: Criar search-knowledge.ts**

Criar `apps/worker/src/agents/tools/search-knowledge.ts`:
```typescript
import { tool } from "ai";
import { z } from "zod";
import { getAdminClient, searchKnowledgeChunks } from "@aula-agente/database";
import { createOpenAI } from "@ai-sdk/openai";
import { embed } from "ai";

export function createSearchKnowledgeTool(organizationId: string, agentId: string, apiKey: string) {
  return tool({
    description: "Search the knowledge base for relevant information about a topic. Use this to find answers from uploaded documents.",
    parameters: z.object({
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/agents/tools/search-knowledge.ts
git commit -m "feat(worker): add RAG search knowledge tool with pgvector"
```

---

### Task 4: Tool — Search FAQ

**Files:**
- Create: `apps/worker/src/agents/tools/search-faq.ts`

- [ ] **Step 1: Criar search-faq.ts**

Criar `apps/worker/src/agents/tools/search-faq.ts`:
```typescript
import { tool } from "ai";
import { z } from "zod";
import { getAdminClient, getFaqsByAgent } from "@aula-agente/database";

export function createSearchFaqTool(agentId: string) {
  return tool({
    description: "Search the FAQ database for common questions and answers. Use this when the user asks a question that might have a standard answer.",
    parameters: z.object({
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/agents/tools/search-faq.ts
git commit -m "feat(worker): add FAQ search tool with keyword matching"
```

---

### Task 5: Tool Registry

**Files:**
- Create: `apps/worker/src/agents/tools/registry.ts`

- [ ] **Step 1: Criar registry.ts**

Criar `apps/worker/src/agents/tools/registry.ts`:
```typescript
import type { ToolsConfig } from "@aula-agente/shared";
import { createSearchKnowledgeTool } from "./search-knowledge";
import { createSearchFaqTool } from "./search-faq";

interface RegistryParams {
  organizationId: string;
  agentId: string;
  toolsConfig: ToolsConfig;
  apiKey: string;
}

export function buildToolsForAgent(params: RegistryParams) {
  const { organizationId, agentId, toolsConfig, apiKey } = params;
  const tools: Record<string, ReturnType<typeof createSearchKnowledgeTool>> = {};

  if (toolsConfig.search_knowledge) {
    tools.searchKnowledge = createSearchKnowledgeTool(organizationId, agentId, apiKey);
  }

  if (toolsConfig.search_faq) {
    tools.searchFaq = createSearchFaqTool(agentId);
  }

  return tools;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/agents/tools/registry.ts
git commit -m "feat(worker): add tool registry for dynamic agent tool configuration"
```

---

### Task 6: Agent Runner — Orquestrador AI SDK

**Files:**
- Create: `apps/worker/src/agents/agent-runner.ts`

- [ ] **Step 1: Criar agent-runner.ts**

Criar `apps/worker/src/agents/agent-runner.ts`:
```typescript
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Agent, LLMProvider, Message } from "@aula-agente/shared";
import { buildToolsForAgent } from "./tools/registry";

interface RunAgentParams {
  agent: Agent;
  messages: Message[];
  currentMessage: Message;
  apiKey: string;
  organizationId: string;
}

interface RunAgentResult {
  text: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  toolCalls: string[];
}

function createModel(provider: LLMProvider, modelName: string, apiKey: string) {
  switch (provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(modelName);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelName);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelName);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

function formatHistoryForLLM(messages: Message[]) {
  return messages.map((msg) => ({
    role: msg.role === "contact" ? "user" as const : "assistant" as const,
    content: msg.content,
  }));
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { agent, messages, currentMessage, apiKey, organizationId } = params;

  const startTime = Date.now();

  const model = createModel(agent.provider, agent.model, apiKey);

  const tools = buildToolsForAgent({
    organizationId,
    agentId: agent.id,
    toolsConfig: agent.tools_config,
    apiKey,
  });

  const history = formatHistoryForLLM(messages);

  const result = await generateText({
    model,
    system: agent.system_prompt,
    messages: [
      ...history,
      { role: "user", content: currentMessage.content },
    ],
    tools,
    maxSteps: 5, // Max tool calling iterations
    temperature: agent.temperature,
    maxTokens: agent.max_tokens,
  });

  const latencyMs = Date.now() - startTime;

  const toolCalls = result.steps
    .flatMap((step) => step.toolCalls || [])
    .map((tc) => tc.toolName);

  return {
    text: result.text,
    model: agent.model,
    tokensUsed: result.usage?.totalTokens || 0,
    latencyMs,
    toolCalls,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/agents/agent-runner.ts
git commit -m "feat(worker): add agent runner with AI SDK multi-provider and tool calling"
```

---

### Task 7: Worker — Process Message

**Files:**
- Create: `apps/worker/src/workers/process-message.ts`

- [ ] **Step 1: Criar process-message.ts**

Criar `apps/worker/src/workers/process-message.ts`:
```typescript
import { Worker } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { ProcessMessageJobData } from "@aula-agente/queue";
import { getRedisConnection, getSendMessageQueue } from "@aula-agente/queue";
import { getAdminClient, getAgentById, getRecentMessages, getConversationById } from "@aula-agente/database";
import { createMessage, updateConversation } from "@aula-agente/database";
import { getInstanceById } from "@aula-agente/database";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock";
import { resolveApiKey } from "../lib/vault";
import { runAgent } from "../agents/agent-runner";

export function startProcessMessageWorker() {
  const worker = new Worker<ProcessMessageJobData>(
    QUEUE_NAMES.PROCESS_MESSAGE,
    async (job) => {
      const { conversationId, messageId, agentId, organizationId } = job.data;

      // Acquire conversation lock
      const lockValue = await acquireConversationLock(conversationId);
      if (!lockValue) {
        throw new Error(`Failed to acquire lock for conversation ${conversationId}`);
      }

      try {
        const db = getAdminClient();

        // Load agent config
        const agent = await getAgentById(db, agentId);
        if (!agent.is_active) {
          console.log(`Agent ${agentId} is inactive, skipping`);
          return;
        }

        // Check if still not in human takeover
        const conversation = await getConversationById(db, conversationId);
        if (conversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} is in human takeover, skipping`);
          return;
        }

        // Resolve API key for this tenant
        const apiKey = await resolveApiKey(organizationId, agent.provider);

        // Load recent message history
        const recentMessages = await getRecentMessages(db, conversationId, 20);

        // Find the current message
        const currentMessage = recentMessages.find((m) => m.id === messageId);
        if (!currentMessage) {
          throw new Error(`Message ${messageId} not found`);
        }

        // Remove current message from history
        const history = recentMessages.filter((m) => m.id !== messageId);

        // Run the agent
        const result = await runAgent({
          agent,
          messages: history,
          currentMessage,
          apiKey,
          organizationId,
        });

        // Save agent response
        const responseMessage = await createMessage(db, {
          conversation_id: conversationId,
          organization_id: organizationId,
          evolution_message_id: null,
          role: "agent",
          content: result.text,
          media_url: null,
          media_type: null,
          metadata: {
            model: result.model,
            tokens_used: result.tokensUsed,
            latency_ms: result.latencyMs,
            tool_calls: result.toolCalls,
          },
        });

        // Update conversation
        await updateConversation(db, conversationId, {
          last_message_at: new Date().toISOString(),
          status: "waiting",
        });

        // Get instance to send reply
        const instance = await getInstanceById(db, conversation.evolution_instance_id);

        // Enqueue send message
        const sendQueue = getSendMessageQueue();
        await sendQueue.add("send-message", {
          conversationId,
          messageId: responseMessage.id,
          instanceId: instance.id,
          phone: conversation.contacts?.phone || "",
          content: result.text,
          organizationId,
        });

        console.log(`Processed message ${messageId} -> response ${responseMessage.id}`);
      } finally {
        await releaseConversationLock(conversationId, lockValue);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} failed:`, err.message);
  });

  console.log("Process-message worker started");
  return worker;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/workers/process-message.ts
git commit -m "feat(worker): add process-message worker with lock, vault, and agent runner"
```

---

### Task 8: Worker — Send Message

**Files:**
- Create: `apps/worker/src/workers/send-message.ts`

- [ ] **Step 1: Criar send-message.ts**

Criar `apps/worker/src/workers/send-message.ts`:
```typescript
import { Worker } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { SendMessageJobData } from "@aula-agente/queue";
import { getRedisConnection } from "@aula-agente/queue";
import { getAdminClient, getInstanceById } from "@aula-agente/database";

async function sendEvolutionText(instanceName: string, phone: string, text: string) {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: phone, text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API send error ${response.status}: ${body}`);
  }

  return response.json();
}

export function startSendMessageWorker() {
  const worker = new Worker<SendMessageJobData>(
    QUEUE_NAMES.SEND_MESSAGE,
    async (job) => {
      const { instanceId, phone, content } = job.data;

      const db = getAdminClient();
      const instance = await getInstanceById(db, instanceId);

      await sendEvolutionText(instance.instance_name, phone, content);

      console.log(`Sent message to ${phone} via instance ${instance.instance_name}`);
    },
    {
      connection: getRedisConnection(),
      concurrency: 20,
      limiter: {
        max: 30,
        duration: 1000, // 30 messages per second max
      },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`Send job ${job?.id} failed:`, err.message);
  });

  console.log("Send-message worker started");
  return worker;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/workers/send-message.ts
git commit -m "feat(worker): add send-message worker with rate limiting"
```

---

### Task 9: Embeddings Pipeline — Chunker + Embedder

**Files:**
- Create: `apps/worker/src/embeddings/chunker.ts`
- Create: `apps/worker/src/embeddings/embedder.ts`

- [ ] **Step 1: Criar chunker.ts**

Criar `apps/worker/src/embeddings/chunker.ts`:
```typescript
interface Chunk {
  content: string;
  metadata: {
    chunk_index: number;
    start_char: number;
    end_char: number;
  };
}

const CHUNK_SIZE = 1000; // characters
const CHUNK_OVERLAP = 200;

export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];

  if (text.length <= CHUNK_SIZE) {
    return [
      {
        content: text.trim(),
        metadata: { chunk_index: 0, start_char: 0, end_char: text.length },
      },
    ];
  }

  let start = 0;
  let chunkIndex = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    // Try to break at a paragraph or sentence boundary
    if (end < text.length) {
      const breakPoints = ["\n\n", "\n", ". ", "! ", "? "];
      for (const bp of breakPoints) {
        const lastBreak = text.lastIndexOf(bp, end);
        if (lastBreak > start + CHUNK_SIZE / 2) {
          end = lastBreak + bp.length;
          break;
        }
      }
    } else {
      end = text.length;
    }

    const content = text.slice(start, end).trim();
    if (content.length > 0) {
      chunks.push({
        content,
        metadata: { chunk_index: chunkIndex, start_char: start, end_char: end },
      });
      chunkIndex++;
    }

    start = end - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }

  return chunks;
}
```

- [ ] **Step 2: Criar embedder.ts**

Criar `apps/worker/src/embeddings/embedder.ts`:
```typescript
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
```

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/embeddings/
git commit -m "feat(worker): add text chunker and embedding generator"
```

---

### Task 10: Worker — Process Document

**Files:**
- Create: `apps/worker/src/workers/process-document.ts`

- [ ] **Step 1: Criar process-document.ts**

Criar `apps/worker/src/workers/process-document.ts`:
```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/workers/process-document.ts
git commit -m "feat(worker): add process-document worker with chunking and embeddings"
```

---

### Task 11: Worker — Takeover Timeout

**Files:**
- Create: `apps/worker/src/workers/takeover-timeout.ts`

- [ ] **Step 1: Criar takeover-timeout.ts**

Criar `apps/worker/src/workers/takeover-timeout.ts`:
```typescript
import { Worker, type Job } from "bullmq";
import { QUEUE_NAMES, HUMAN_TAKEOVER_TIMEOUT_MS } from "@aula-agente/shared";
import type { TakeoverTimeoutJobData } from "@aula-agente/queue";
import { getRedisConnection, getTakeoverTimeoutQueue } from "@aula-agente/queue";
import { getAdminClient, getExpiredTakeovers, updateConversation } from "@aula-agente/database";

export function startTakeoverTimeoutWorker() {
  const worker = new Worker<TakeoverTimeoutJobData>(
    QUEUE_NAMES.TAKEOVER_TIMEOUT,
    async (_job: Job) => {
      const db = getAdminClient();
      const expired = await getExpiredTakeovers(db, HUMAN_TAKEOVER_TIMEOUT_MS);

      for (const conversation of expired) {
        await updateConversation(db, conversation.id, {
          is_human_takeover: false,
          human_takeover_at: null,
        });
        console.log(`Auto-released takeover for conversation ${conversation.id}`);
      }

      if (expired.length > 0) {
        console.log(`Released ${expired.length} expired takeovers`);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );

  // Schedule repeating job every 5 minutes
  const queue = getTakeoverTimeoutQueue();
  queue.upsertJobScheduler(
    "takeover-timeout-scheduler",
    { every: 5 * 60 * 1000 },
    { name: "check-expired-takeovers" }
  );

  worker.on("failed", (job, err) => {
    console.error(`Takeover timeout job ${job?.id} failed:`, err.message);
  });

  console.log("Takeover-timeout worker started (runs every 5 min)");
  return worker;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/workers/takeover-timeout.ts
git commit -m "feat(worker): add takeover timeout worker with scheduled cleanup"
```

---

### Task 12: Worker Bootstrap — Registrar Todos os Workers

**Files:**
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Atualizar index.ts com registro de todos os workers**

Substituir conteudo de `apps/worker/src/index.ts`:
```typescript
import "dotenv/config";
import { startProcessMessageWorker } from "./workers/process-message";
import { startSendMessageWorker } from "./workers/send-message";
import { startProcessDocumentWorker } from "./workers/process-document";
import { startTakeoverTimeoutWorker } from "./workers/takeover-timeout";

async function main() {
  console.log("Starting workers...");

  const workers = [
    startProcessMessageWorker(),
    startSendMessageWorker(),
    startProcessDocumentWorker(),
    startTakeoverTimeoutWorker(),
  ];

  console.log(`${workers.length} workers started successfully`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down workers...");
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Instalar dependencias do worker**

```bash
cd apps/worker && pnpm add ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google zod
```

- [ ] **Step 3: Verificar tipagem**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/
git commit -m "feat(worker): register all workers in bootstrap and add AI SDK dependencies"
```

---

### Task 13: Verificacao Final da Fase 3

- [ ] **Step 1: Verificar tipagem do monorepo inteiro**

```bash
pnpm typecheck
```

Esperado: sem erros.

- [ ] **Step 2: Verificar que worker inicia (precisa de Redis rodando)**

```bash
docker compose up redis -d
pnpm dev:worker
# Expected: "Starting workers...", "4 workers started successfully"
```

- [ ] **Step 3: Commit final se houver ajustes**

```bash
git add -A && git status
git commit -m "chore: phase 3 final adjustments"
```
