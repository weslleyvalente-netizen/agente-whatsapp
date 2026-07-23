# Agent Vehicle Catalog Photo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an opted-in agent search the Moto e Trilha vehicle catalog and send a customer the vehicle's main photo as a real WhatsApp image message.

**Architecture:** Two new Vercel AI SDK tools (`searchCatalog`, `sendVehiclePhoto`) added to the existing worker tool registry, gated by a new `tools_config.send_catalog_photo` flag. `searchCatalog` fetches the full 27-vehicle catalog once from the confirmed tRPC endpoint and filters/formats client-side (no reliance on the remote API's own search quality). `sendVehiclePhoto` saves a `messages` row and enqueues a send job carrying new optional media fields; the existing `send-message` worker gains a media branch that calls Evolution's confirmed `sendMedia` endpoint instead of `sendText`.

**Tech Stack:** Vercel AI SDK `tool()`/zod (matches `search-faq.ts`/`search-knowledge.ts`), BullMQ (existing `send-message` queue), vitest (new for `apps/worker`, mirroring `apps/api`'s setup).

## Global Constraints

- Only the vehicle's main photo (`imageUrl`) is ever sent — no galleries, no `extraImages`. (spec Non-goals)
- The catalog base URL (`https://catalogomotoetrilha.manus.space`) is hardcoded, not configurable per org/agent. (spec Non-goals)
- Confirmed live contracts, use exactly these — do not re-derive or guess:
  - Catalog: `GET https://catalogomotoetrilha.manus.space/api/trpc/vehicles.list?batch=1&input=<url-encoded JSON>` where JSON is `{"0":{"json":{"search":"<query>"}}}`. Response: `[{"result":{"data":{"json": [Vehicle, ...]}}}]`. `Vehicle.imageUrl` is a **relative** path.
  - Send media: `POST {EVOLUTION_API_URL}/message/sendMedia/{instanceName}`, header `apikey: {EVOLUTION_API_KEY}`, JSON body `{ "number": "<phone>", "mediatype": "image", "media": "<fully-qualified URL>", "caption": "<text>" }`.
- On zero search matches, return the catalog's other available vehicles as suggestions rather than a flat "not found" — the agent decides what's worth suggesting, we don't compute similarity. (spec, "searchCatalog" section)

---

### Task 1: Catalog search tool

**Files:**
- Modify: `apps/worker/package.json` (add vitest)
- Create: `apps/worker/src/agents/tools/search-catalog.ts`
- Test: `apps/worker/src/agents/tools/search-catalog.test.ts`

**Interfaces:**
- Produces: `createSearchCatalogTool()` — no arguments (catalog URL is hardcoded), returns an AI SDK `Tool` with `inputSchema: { query: string }`. Registered as `searchCatalog` in Task 3.
- Produces (for Task 3's tests/reuse, not for external consumption otherwise): `filterVehicles(vehicles, query)`, `formatVehicleList(vehicles)`, `buildCatalogSearchResult(vehicles, query)` — all pure, exported from `search-catalog.ts`.

- [ ] **Step 1: Add vitest to the worker package**

Replace the full contents of `apps/worker/package.json` with:

```json
{
  "name": "@aula-agente/worker",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "echo 'no lint configured'"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^4.0.10",
    "@ai-sdk/google": "^4.0.10",
    "@ai-sdk/openai": "^4.0.9",
    "@aula-agente/database": "workspace:*",
    "@aula-agente/queue": "workspace:*",
    "@aula-agente/shared": "workspace:*",
    "ai": "^7.0.18",
    "bullmq": "^5.30.0",
    "dotenv": "^16.4.0",
    "ioredis": "^5.4.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "type": "module"
}
```

Run: `pnpm install`
Expected: lockfile updates, exits 0.

- [ ] **Step 2: Write the failing tests**

Create `apps/worker/src/agents/tools/search-catalog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filterVehicles, formatVehicleList, buildCatalogSearchResult } from "./search-catalog.js";

const vehicles = [
  { id: 1, modelo: "BROS 160 ESDD ABS", marca: "HONDA", ano: 2026, preco: 28900, imageUrl: "/manus-storage/vehicles/bros.png" },
  { id: 2, modelo: "YZF R15 - 155 ABS Gas", marca: "YAMAHA", ano: 2026, preco: 28900, imageUrl: "/manus-storage/vehicles/r15.png" },
  { id: 3, modelo: "AVELLOZ AZ1 50CC", marca: "AVELLOZ", ano: 2026, preco: 13900, imageUrl: "/manus-storage/vehicles/az1.png" },
];

describe("filterVehicles", () => {
  it("matches by model name, case-insensitive", () => {
    expect(filterVehicles(vehicles, "bros 160")).toEqual([vehicles[0]]);
  });

  it("matches by brand name", () => {
    expect(filterVehicles(vehicles, "yamaha")).toEqual([vehicles[1]]);
  });

  it("returns everything for an empty query", () => {
    expect(filterVehicles(vehicles, "")).toEqual(vehicles);
  });

  it("returns nothing for a query with no match", () => {
    expect(filterVehicles(vehicles, "CB500")).toEqual([]);
  });
});

describe("formatVehicleList", () => {
  it("formats price in pt-BR currency style and resolves the full image URL", () => {
    const result = formatVehicleList([vehicles[0]]);
    expect(result).toBe(
      "- BROS 160 ESDD ABS (HONDA, 2026) — R$ 28.900 — foto: https://catalogomotoetrilha.manus.space/manus-storage/vehicles/bros.png"
    );
  });

  it("caps the list at 5 vehicles", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...vehicles[0], id: i, modelo: `MODEL ${i}` }));
    const result = formatVehicleList(many);
    expect(result.split("\n")).toHaveLength(5);
  });
});

describe("buildCatalogSearchResult", () => {
  it("returns the formatted match list when the query hits", () => {
    const result = buildCatalogSearchResult(vehicles, "bros");
    expect(result).toContain("BROS 160 ESDD ABS");
    expect(result).not.toContain("Nenhum veículo encontrado");
  });

  it("falls back to suggesting other vehicles when nothing matches", () => {
    const result = buildCatalogSearchResult(vehicles, "CB500");
    expect(result).toContain('Nenhum veículo encontrado para "CB500"');
    expect(result).toContain("BROS 160 ESDD ABS");
    expect(result).toContain("YZF R15");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @aula-agente/worker exec vitest run src/agents/tools/search-catalog.test.ts`
Expected: FAIL — `Cannot find module './search-catalog.js'` (the module doesn't exist yet).

- [ ] **Step 4: Implement the tool**

Create `apps/worker/src/agents/tools/search-catalog.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";

const CATALOG_BASE_URL = "https://catalogomotoetrilha.manus.space";

interface CatalogVehicle {
  id: number;
  modelo: string;
  marca: string;
  ano: number;
  preco: number;
  imageUrl: string;
}

export function filterVehicles(vehicles: CatalogVehicle[], query: string): CatalogVehicle[] {
  const q = query.trim().toLowerCase();
  if (!q) return vehicles;
  return vehicles.filter(
    (v) => v.modelo.toLowerCase().includes(q) || v.marca.toLowerCase().includes(q)
  );
}

export function formatVehicleList(vehicles: CatalogVehicle[]): string {
  return vehicles
    .slice(0, 5)
    .map((v) => {
      const price = `R$ ${v.preco.toLocaleString("pt-BR")}`;
      const imageUrl = `${CATALOG_BASE_URL}${v.imageUrl}`;
      return `- ${v.modelo} (${v.marca}, ${v.ano}) — ${price} — foto: ${imageUrl}`;
    })
    .join("\n");
}

export function buildCatalogSearchResult(vehicles: CatalogVehicle[], query: string): string {
  const matches = filterVehicles(vehicles, query);
  if (matches.length > 0) {
    return formatVehicleList(matches);
  }
  const fallback = vehicles.slice(0, 5);
  return `Nenhum veículo encontrado para "${query}". Aqui estão outras opções disponíveis no catálogo — se alguma for parecida com o que o cliente quer, sugira antes de dizer que não há disponibilidade:\n${formatVehicleList(fallback)}`;
}

async function fetchCatalog(): Promise<CatalogVehicle[]> {
  const input = encodeURIComponent(JSON.stringify({ "0": { json: { search: "" } } }));
  const response = await fetch(`${CATALOG_BASE_URL}/api/trpc/vehicles.list?batch=1&input=${input}`);
  if (!response.ok) {
    throw new Error(`Catalog API error ${response.status}`);
  }
  const data = await response.json();
  return data[0].result.data.json as CatalogVehicle[];
}

export function createSearchCatalogTool() {
  return tool({
    description:
      "Search the vehicle catalog by brand or model name. Returns matching vehicles with price and photo URL, or suggestions from the catalog if nothing matches exactly.",
    inputSchema: z.object({
      query: z.string().describe("Brand or model name to search for, e.g. 'Bros 160' or 'Honda'"),
    }),
    execute: async ({ query }) => {
      const vehicles = await fetchCatalog();
      return buildCatalogSearchResult(vehicles, query);
    },
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @aula-agente/worker exec vitest run src/agents/tools/search-catalog.test.ts`
Expected: PASS — 8 tests passing.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @aula-agente/worker exec tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/package.json apps/worker/src/agents/tools/search-catalog.ts apps/worker/src/agents/tools/search-catalog.test.ts pnpm-lock.yaml
git commit -m "feat: add searchCatalog agent tool for the vehicle catalog"
```

---

### Task 2: Media-sending capability in the send pipeline

**Files:**
- Modify: `packages/queue/src/types.ts`
- Modify: `apps/worker/src/workers/send-message.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `SendMessageJobData` gains three optional fields (`mediaUrl?: string`, `mediaType?: "image"`, `caption?: string`) that Task 3's `sendVehiclePhoto` tool will populate when enqueueing a job.

- [ ] **Step 1: Extend the send-message job data type**

In `packages/queue/src/types.ts`, replace:

```ts
export interface SendMessageJobData {
  conversationId: string;
  messageId: string;
  instanceId: string;
  phone: string;
  content: string;
  organizationId: string;
}
```

with:

```ts
export interface SendMessageJobData {
  conversationId: string;
  messageId: string;
  instanceId: string;
  phone: string;
  content: string;
  organizationId: string;
  mediaUrl?: string;
  mediaType?: "image";
  caption?: string;
}
```

- [ ] **Step 2: Add the media-send branch to the worker**

Replace the full contents of `apps/worker/src/workers/send-message.ts` with:

```ts
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

async function sendEvolutionMedia(instanceName: string, phone: string, mediaUrl: string, caption: string) {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: phone, mediatype: "image", media: mediaUrl, caption }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API media send error ${response.status}: ${body}`);
  }

  return response.json();
}

export function startSendMessageWorker() {
  const worker = new Worker<SendMessageJobData>(
    QUEUE_NAMES.SEND_MESSAGE,
    async (job) => {
      const { instanceId, phone, content, mediaUrl, caption } = job.data;

      const db = getAdminClient();
      const instance = await getInstanceById(db, instanceId);

      if (mediaUrl) {
        await sendEvolutionMedia(instance.instance_name, phone, mediaUrl, caption || content);
      } else {
        await sendEvolutionText(instance.instance_name, phone, content);
      }

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

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aula-agente/queue exec tsc --noEmit && pnpm --filter @aula-agente/worker exec tsc --noEmit`
Expected: both exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add packages/queue/src/types.ts apps/worker/src/workers/send-message.ts
git commit -m "feat: add media-sending branch to the send-message worker"
```

No standalone verification here — this task's contract (`POST /message/sendMedia/{instance}` with a plain URL) was already confirmed live against the real Evolution instance while writing the design spec. Full end-to-end verification (a real photo arriving from an agent's tool call) happens in Task 3.

---

### Task 3: sendVehiclePhoto tool and wiring

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/schemas/agent.ts`
- Create: `apps/worker/src/agents/tools/send-vehicle-photo.ts`
- Modify: `apps/worker/src/agents/tools/registry.ts`
- Modify: `apps/worker/src/agents/agent-runner.ts`
- Modify: `apps/worker/src/workers/process-message.ts`

**Interfaces:**
- Consumes: `createSearchCatalogTool()` from Task 1 (`apps/worker/src/agents/tools/search-catalog.js`). `SendMessageJobData`'s `mediaUrl`/`mediaType`/`caption` fields from Task 2.
- Produces: `createSendVehiclePhotoTool(context: { conversationId: string; organizationId: string; instanceId: string; phone: string })` and `formatVehicleCaption(modelo: string, preco: number): string`, both exported from `send-vehicle-photo.ts`. `buildToolsForAgent`'s params gain `conversationId`, `instanceId`, `phone`. `runAgent`'s params gain the same three fields.

- [ ] **Step 1: Add the tools_config flag**

In `packages/shared/src/types/agent.ts`, replace:

```ts
export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
}
```

with:

```ts
export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
}
```

In `packages/shared/src/schemas/agent.ts`, replace:

```ts
export const toolsConfigSchema = z.object({
  search_knowledge: z.boolean().default(true),
  search_faq: z.boolean().default(true),
});
```

with:

```ts
export const toolsConfigSchema = z.object({
  search_knowledge: z.boolean().default(true),
  search_faq: z.boolean().default(true),
  send_catalog_photo: z.boolean().default(false),
});
```

and replace:

```ts
  tools_config: toolsConfigSchema.default({ search_knowledge: true, search_faq: true }),
```

with:

```ts
  tools_config: toolsConfigSchema.default({ search_knowledge: true, search_faq: true, send_catalog_photo: false }),
```

- [ ] **Step 2: Rebuild the shared package**

Run: `pnpm --filter @aula-agente/shared build`
Expected: exits 0, no output.

- [ ] **Step 3: Create the send-vehicle-photo tool**

Create `apps/worker/src/agents/tools/send-vehicle-photo.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import { createMessage, getAdminClient } from "@aula-agente/database";
import { getSendMessageQueue } from "@aula-agente/queue";

interface SendVehiclePhotoContext {
  conversationId: string;
  organizationId: string;
  instanceId: string;
  phone: string;
}

export function formatVehicleCaption(modelo: string, preco: number): string {
  return `${modelo} — R$ ${preco.toLocaleString("pt-BR")}`;
}

export function createSendVehiclePhotoTool(context: SendVehiclePhotoContext) {
  return tool({
    description:
      "Send the customer a real WhatsApp photo of a specific vehicle. Only call this after searchCatalog, using the exact modelo, preco, and imageUrl it returned for the vehicle the customer wants to see.",
    inputSchema: z.object({
      modelo: z.string().describe("Exact vehicle model name from a prior searchCatalog result"),
      preco: z.number().describe("Exact vehicle price from a prior searchCatalog result"),
      imageUrl: z.string().describe("Exact fully-qualified image URL from a prior searchCatalog result"),
    }),
    execute: async ({ modelo, preco, imageUrl }) => {
      const caption = formatVehicleCaption(modelo, preco);
      const db = getAdminClient();

      const message = await createMessage(db, {
        conversation_id: context.conversationId,
        organization_id: context.organizationId,
        evolution_message_id: null,
        role: "agent",
        content: caption,
        media_url: imageUrl,
        media_type: "image",
        metadata: null,
      });

      const sendQueue = getSendMessageQueue();
      await sendQueue.add("send-message", {
        conversationId: context.conversationId,
        messageId: message.id,
        instanceId: context.instanceId,
        phone: context.phone,
        content: caption,
        mediaUrl: imageUrl,
        mediaType: "image",
        caption,
        organizationId: context.organizationId,
      });

      return "Foto enviada.";
    },
  });
}
```

- [ ] **Step 4: Wire both catalog tools into the registry**

Replace the full contents of `apps/worker/src/agents/tools/registry.ts` with:

```ts
import { tool } from "ai";
import type { ToolsConfig } from "@aula-agente/shared";
import { createSearchKnowledgeTool } from "./search-knowledge.js";
import { createSearchFaqTool } from "./search-faq.js";
import { createSearchCatalogTool } from "./search-catalog.js";
import { createSendVehiclePhotoTool } from "./send-vehicle-photo.js";

interface RegistryParams {
  organizationId: string;
  agentId: string;
  toolsConfig: ToolsConfig;
  apiKey: string;
  conversationId: string;
  instanceId: string;
  phone: string;
}

export function buildToolsForAgent(params: RegistryParams): Record<string, ReturnType<typeof tool>> {
  const { organizationId, agentId, toolsConfig, apiKey, conversationId, instanceId, phone } = params;
  const tools: Record<string, ReturnType<typeof tool>> = {};

  if (toolsConfig.search_knowledge) {
    tools.searchKnowledge = createSearchKnowledgeTool(organizationId, agentId, apiKey);
  }

  if (toolsConfig.search_faq) {
    tools.searchFaq = createSearchFaqTool(agentId);
  }

  if (toolsConfig.send_catalog_photo) {
    tools.searchCatalog = createSearchCatalogTool();
    tools.sendVehiclePhoto = createSendVehiclePhotoTool({ conversationId, organizationId, instanceId, phone });
  }

  return tools;
}
```

- [ ] **Step 5: Pass conversation/instance/phone through the agent runner**

In `apps/worker/src/agents/agent-runner.ts`, replace:

```ts
interface RunAgentParams {
  agent: Agent;
  messages: Message[];
  currentMessage: Message;
  apiKey: string;
  organizationId: string;
}
```

with:

```ts
interface RunAgentParams {
  agent: Agent;
  messages: Message[];
  currentMessage: Message;
  apiKey: string;
  organizationId: string;
  conversationId: string;
  instanceId: string;
  phone: string;
}
```

Replace:

```ts
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
```

with:

```ts
export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { agent, messages, currentMessage, apiKey, organizationId, conversationId, instanceId, phone } = params;

  const startTime = Date.now();

  const model = createModel(agent.provider, agent.model, apiKey);

  const tools = buildToolsForAgent({
    organizationId,
    agentId: agent.id,
    toolsConfig: agent.tools_config,
    apiKey,
    conversationId,
    instanceId,
    phone,
  });
```

- [ ] **Step 6: Load the instance earlier and pass it through in process-message**

In `apps/worker/src/workers/process-message.ts`, replace:

```ts
        // Check if still not in human takeover
        const conversation = await getConversationById(db, conversationId);
        if (conversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} is in human takeover, skipping`);
          return;
        }

        // Resolve API key for this tenant
        const apiKey = await resolveApiKey(organizationId, agent.provider);
```

with:

```ts
        // Check if still not in human takeover
        const conversation = await getConversationById(db, conversationId);
        if (conversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} is in human takeover, skipping`);
          return;
        }

        // Load instance now — needed both by agent tools (to send a photo
        // mid-turn) and further down to send the text reply.
        const instance = await getInstanceById(db, conversation.evolution_instance_id);

        // Resolve API key for this tenant
        const apiKey = await resolveApiKey(organizationId, agent.provider);
```

Replace:

```ts
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
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
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
          phone: conversation.wa_contacts?.phone || "",
          content: result.text,
          organizationId,
        });

        console.log(`Processed message ${messageId} -> response ${responseMessage.id}`);
```

with:

```ts
        // Run the agent
        const result = await runAgent({
          agent,
          messages: history,
          currentMessage,
          apiKey,
          organizationId,
          conversationId,
          instanceId: instance.id,
          phone: conversation.wa_contacts?.phone || "",
        });

        // Save and send the agent's text reply — skipped if the agent's
        // final text is empty, which now legitimately happens when it only
        // called sendVehiclePhoto and considered the photo itself the
        // complete reply (that tool already saved and enqueued its own
        // message independently of this one).
        if (result.text.trim()) {
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
              input_tokens: result.inputTokens,
              output_tokens: result.outputTokens,
              latency_ms: result.latencyMs,
              tool_calls: result.toolCalls,
            },
          });

          const sendQueue = getSendMessageQueue();
          await sendQueue.add("send-message", {
            conversationId,
            messageId: responseMessage.id,
            instanceId: instance.id,
            phone: conversation.wa_contacts?.phone || "",
            content: result.text,
            organizationId,
          });

          console.log(`Processed message ${messageId} -> response ${responseMessage.id}`);
        } else {
          console.log(`Processed message ${messageId} -> no text reply (tool-only response)`);
        }

        // Update conversation
        await updateConversation(db, conversationId, {
          last_message_at: new Date().toISOString(),
          status: "waiting",
        });
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @aula-agente/worker exec tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types/agent.ts packages/shared/src/schemas/agent.ts apps/worker/src/agents/tools/send-vehicle-photo.ts apps/worker/src/agents/tools/registry.ts apps/worker/src/agents/agent-runner.ts apps/worker/src/workers/process-message.ts
git commit -m "feat: add sendVehiclePhoto tool and wire it into the agent pipeline"
```

- [ ] **Step 9: Deploy and manually verify live**

This task's real behavior only exists once the `worker` and `api` (for the rebuilt `@aula-agente/shared` package) services are redeployed on EasyPanel — deploy both.

The frontend toggle for `send_catalog_photo` doesn't exist until Task 4, so enable it temporarily for the live test via direct SQL (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` from the repo's root `.env`, same pattern used throughout this project):

```bash
curl -s -X PATCH "${SUPABASE_URL}/rest/v1/agents?id=eq.<Helena's agent id>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"tools_config": {"search_knowledge": true, "search_faq": true, "send_catalog_photo": true}}'
```

Then, using the project's own safe test WhatsApp line (not a real customer conversation), send a message asking about a specific catalog vehicle (e.g. "vocês têm a Bros 160?") through the real webhook — either by actually messaging the connected test number from a phone, or with a synthetic webhook POST to `/webhooks/evolution` matching the pattern used earlier in this project. Confirm:
- A real photo arrives on WhatsApp (not a text link).
- The photo message appears in the conversation in the Inbox (even though Task 4's image rendering isn't built yet, the row should exist — check via the same Supabase REST query pattern used elsewhere in this project, filtering `messages` by `media_type=eq.image`).
- The agent's follow-up text (if any) arrives as a normal second message.

If the test contact's `tools_config` was toggled directly for this test, leave it as `send_catalog_photo: true` afterward — Task 4 will make it independently controllable from the UI, and this is the intended agent for the feature anyway.

---

### Task 4: Agent settings toggle and inbox image rendering

**Files:**
- Modify: `apps/web/src/components/agents/agent-form.tsx`
- Modify: `apps/web/src/components/inbox/message-bubble.tsx`

**Interfaces:**
- Consumes: `tools_config.send_catalog_photo` field from Task 3 (already flows through `createAgentSchema`/`toolsConfigSchema`, no new zod import needed — `agent-form.tsx` already imports `createAgentSchema` from `@aula-agente/shared`).
- Consumes: `Message.media_type`/`Message.media_url` (already existing fields, unchanged).

- [ ] **Step 1: Add the catalog toggle to the agent form**

In `apps/web/src/components/agents/agent-form.tsx`, find the `defaultValues` block:

```tsx
      tools_config: { search_knowledge: true, search_faq: true },
```

Replace with:

```tsx
      tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: false },
```

Then find the FAQ toggle block:

```tsx
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Busca de FAQs</p>
              <p className="text-sm text-muted-foreground">Permite ao agente consultar perguntas frequentes</p>
            </div>
            <Switch
              checked={form.watch("tools_config.search_faq")}
              onCheckedChange={(v) => form.setValue("tools_config.search_faq", v)}
            />
          </div>
```

Add this block immediately after it (still inside the same `CardContent`):

```tsx

          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Catálogo de Veículos</p>
              <p className="text-sm text-muted-foreground">Permite ao agente buscar veículos e enviar fotos pelo WhatsApp</p>
            </div>
            <Switch
              checked={form.watch("tools_config.send_catalog_photo")}
              onCheckedChange={(v) => form.setValue("tools_config.send_catalog_photo", v)}
            />
          </div>
```

- [ ] **Step 2: Render sent photos in the chat**

In `apps/web/src/components/inbox/message-bubble.tsx`, find:

```tsx
        <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
```

Replace with:

```tsx
        {message.media_type === "image" && message.media_url && (
          <img
            src={message.media_url}
            alt="Foto enviada"
            className="mb-1 max-w-full rounded-md"
          />
        )}
        <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aula-agente/web exec tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 4: Manually verify in the browser**

With the web dev server running:
1. Open an agent's edit page (`/agents/<id>`). Confirm the new "Catálogo de Veículos" toggle appears below "Busca de FAQs" and reflects/saves the `send_catalog_photo` value.
2. Open the Inbox conversation that received the test photo in Task 3's live verification. Confirm the photo now renders as an actual image inside the chat bubble, with the caption text below it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agents/agent-form.tsx apps/web/src/components/inbox/message-bubble.tsx
git commit -m "feat: add catalog-photo toggle to agent settings, render sent photos in the inbox"
```

---

## Self-Review Notes

- **Spec coverage:** confirmed catalog/sendMedia contracts → Global Constraints + Task 1/2 code. Main-photo-only → `formatVehicleList` only ever uses `imageUrl`, never `extraImages`. Hardcoded catalog URL → `CATALOG_BASE_URL` constant, no config plumbing. Search-then-suggest fallback → `buildCatalogSearchResult`. Search-separate-from-send flow (ask before sending on multiple matches) → this is prompt-level agent behavior enabled by the two-tool split (search returns a list, sending requires the model to already know which one) — not something the code enforces mechanically, matching the spec's own framing ("the agent decides", not an algorithm). Inbox display of sent photos → Task 4 Step 2. Agent settings toggle → Task 4 Step 1.
- **Type consistency:** `SendVehiclePhotoContext` (Task 3) fields (`conversationId`, `organizationId`, `instanceId`, `phone`) match exactly what `registry.ts`'s `RegistryParams` and `agent-runner.ts`'s `RunAgentParams` add and pass down — traced the full chain from `process-message.ts` → `runAgent` → `buildToolsForAgent` → `createSendVehiclePhotoTool`.
- **Necessary deviation from the spec's literal text:** the spec's "Tool context" section didn't address what happens when the agent's final text is empty (a new possibility once a tool can fully satisfy the customer's request on its own). Task 3 Step 6 adds a guard skipping the text-reply save/send in that case — without it, every tool-only response would also send a blank follow-up WhatsApp message.
- **No placeholders:** every step has complete, runnable code, including full before/after blocks for every edited file.
