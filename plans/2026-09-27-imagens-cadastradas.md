# Imagens cadastradas no Conhecimento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Helena envia pelo WhatsApp uma imagem cadastrada no painel (primeiro caso: arte "Catálogo Libera Cred") quando a situação descrita no cadastro acontecer.

**Architecture:** Lista `knowledge.imagens` no rascunho/versão do agente (publicada junto com o resto da config). Arquivos ficam num bucket público do Supabase Storage, gravados por uma rota da API. Nova ferramenta `sendRegisteredImage` lê a imagem da versão publicada (ou do rascunho, no playground) e enfileira o envio pela mesma fila das fotos de catálogo.

**Tech Stack:** TypeScript, zod, Vercel AI SDK (`tool`), Fastify + `@fastify/multipart`, Supabase (Postgres + Storage), Next.js (painel), Vitest.

**Spec:** `specs/2026-09-27-imagens-cadastradas-design.md`

## Global Constraints

- Trabalhar numa worktree/branch `feat/imagens-cadastradas`; nada em `main` sem merge aprovado.
- Imagem: só `image/png`, `image/jpeg`, `image/webp`; máximo 5 MB (5 * 1024 * 1024 bytes).
- Bucket: `agent-media`, público; caminho `{organizationId}/{agentId}/{uuid}.{ext}`.
- Limites do item: `titulo` ≤ 150, `quando_enviar` ≤ 500, `legenda` ≤ 1000; no máximo 20 imagens por agente.
- `tools_config.send_registered_image` é opcional no tipo (linhas antigas não têm); ausente = desligado.
- A URL da imagem nunca entra no prompt.
- A ferramenta real lê só a **versão publicada**; o playground (sandbox) lê o **rascunho** e nunca enfileira envio.
- Remover imagem da lista não apaga o arquivo do bucket.
- Produção (migração, deploy, cadastro da arte, publicação): cada passo só com aprovação explícita do usuário. `apps/web` local aponta para a API de produção — não testar edição no painel local sem combinar.
- Textos visíveis ao usuário/painel em português.

## Review Focus

- Imagem cadastrada no rascunho mas ainda não publicada: cliente real pede o catálogo → ferramenta não acha na versão publicada e a Helena não pode dizer que enviou (teste na Task 2).
- Arquivo com extensão `.png` mas conteúdo que não é imagem (ou PDF renomeado) → recusado pela checagem de assinatura, não pela extensão (teste na Task 3).
- Upload para um `agentId` de outra organização → 404, nada gravado (teste na Task 3).
- Rascunho/versão antigos sem `imagens` → prompt compila sem seção de imagens e schema aceita (testes na Task 1).
- Falha do Storage/fila no meio do envio → ferramenta devolve erro e não "Imagem enviada." (teste na Task 2).

---

### Task 1: Tipos, schema, prompt e seção do painel (`packages/shared`)

**Files:**
- Modify: `packages/shared/src/types/agent-config.ts` (interfaces `AgentLinkItem`/`AgentKnowledgeConfig`, ~linhas 78-90)
- Modify: `packages/shared/src/types/agent.ts` (`ToolsConfig`, ~linha 33)
- Modify: `packages/shared/src/schemas/agent-config.ts` (~linhas 77-90)
- Modify: `packages/shared/src/schemas/agent.ts` (`toolsConfigSchema`, linhas 10-23)
- Modify: `packages/shared/src/prompt-builder.ts` (`compileKnowledgeSection`)
- Modify: `packages/shared/src/agent-config-sections.ts` (`SECTION_ITEMS.conhecimento`)
- Test: `packages/shared/src/prompt-builder.test.ts`, create `packages/shared/src/schemas/agent-image.test.ts`

**Interfaces:**
- Produces:
  - `interface AgentImageItem { id: string; titulo: string; quando_enviar: string; legenda: string; url: string; storage_path: string; ativo: boolean }`
  - `AgentKnowledgeConfig.imagens?: AgentImageItem[]`
  - `ToolsConfig.send_registered_image?: boolean`
  - `agentImageItemSchema` (zod) exportado de `@aula-agente/shared`
  - `SECTION_ITEMS.conhecimento.imagens = "Imagens"`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/schemas/agent-image.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { agentKnowledgeConfigSchema, agentImageItemSchema } from "./agent-config.js";
import { toolsConfigSchema } from "./agent.js";

const image = {
  id: "3f0c2c1e-8a47-4a55-9d3c-2f4f7c2b9a10",
  titulo: "Catálogo Libera Cred",
  quando_enviar: "cliente pede o catálogo, todas as motos ou as opções do Libera Cred",
  legenda: "Motos do plano Libera Cred — preços de referência do plano (tabela 23/09/2026).",
  url: "https://example.supabase.co/storage/v1/object/public/agent-media/org/agent/x.png",
  storage_path: "org/agent/x.png",
  ativo: true,
};

describe("agentImageItemSchema", () => {
  it("accepts a valid image item", () => {
    expect(agentImageItemSchema.safeParse(image).success).toBe(true);
  });

  it("rejects fields over their limits", () => {
    expect(agentImageItemSchema.safeParse({ ...image, titulo: "x".repeat(151) }).success).toBe(false);
    expect(agentImageItemSchema.safeParse({ ...image, quando_enviar: "x".repeat(501) }).success).toBe(false);
    expect(agentImageItemSchema.safeParse({ ...image, legenda: "x".repeat(1001) }).success).toBe(false);
  });

  it("rejects a non-URL url", () => {
    expect(agentImageItemSchema.safeParse({ ...image, url: "catalogo.png" }).success).toBe(false);
  });
});

describe("agentKnowledgeConfigSchema.imagens", () => {
  it("defaults to an empty list for configs saved before this feature", () => {
    const parsed = agentKnowledgeConfigSchema.parse({ precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true });
    expect(parsed.imagens).toEqual([]);
  });

  it("caps the list at 20 images", () => {
    const imagens = Array.from({ length: 21 }, (_, i) => ({ ...image, id: `id-${i}` }));
    expect(agentKnowledgeConfigSchema.safeParse({ imagens }).success).toBe(false);
  });
});

describe("toolsConfigSchema.send_registered_image", () => {
  it("defaults to false", () => {
    expect(toolsConfigSchema.parse({}).send_registered_image).toBe(false);
  });
});
```

Append to `packages/shared/src/prompt-builder.test.ts` (inside the existing `describe("compileSystemPrompt", ...)`):

```ts
  it("lists only active registered images, by id and when-to-send, never the URL", () => {
    const result = compileSystemPrompt(
      baseConfig({
        knowledge: {
          precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true,
          imagens: [
            { id: "img-1", titulo: "Catálogo Libera Cred", quando_enviar: "cliente pede o catálogo", legenda: "L", url: "https://x.test/a.png", storage_path: "o/a/a.png", ativo: true },
            { id: "img-2", titulo: "Folder antigo", quando_enviar: "nunca", legenda: "L", url: "https://x.test/b.png", storage_path: "o/a/b.png", ativo: false },
          ],
        },
      })
    );
    expect(result).toContain("# Imagens cadastradas");
    expect(result).toContain("sendRegisteredImage");
    expect(result).toContain("- id: img-1 | Catálogo Libera Cred | Quando enviar: cliente pede o catálogo");
    expect(result).not.toContain("img-2");
    expect(result).not.toContain("https://x.test");
  });

  it("omits the images section when there are no active images or the field is missing", () => {
    expect(compileSystemPrompt(baseConfig())).not.toContain("Imagens cadastradas");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @aula-agente/shared test`
Expected: FAIL — `agentImageItemSchema` is not exported / `Imagens cadastradas` not in output.

- [ ] **Step 3: Implement**

`packages/shared/src/types/agent-config.ts` — after `AgentLinkItem`:

```ts
export interface AgentImageItem {
  id: string;
  titulo: string;
  quando_enviar: string;
  legenda: string;
  url: string;
  storage_path: string;
  ativo: boolean;
}
```

and in `AgentKnowledgeConfig` add:

```ts
  // Optional: drafts/versions saved before this feature have no key.
  // Every reader must treat a missing list as [].
  imagens?: AgentImageItem[];
```

`packages/shared/src/types/agent.ts` — in `ToolsConfig`, after `update_qualification`:

```ts
  // Optional: rows written before this feature shipped don't have this key;
  // missing means off.
  send_registered_image?: boolean;
```

`packages/shared/src/schemas/agent-config.ts` — after `agentLinkItemSchema`:

```ts
export const agentImageItemSchema = z.object({
  id: z.string().min(1),
  titulo: z.string().max(150),
  quando_enviar: z.string().max(500),
  legenda: z.string().max(1000),
  url: z.string().url(),
  storage_path: z.string().min(1).max(500),
  ativo: z.boolean().default(true),
});
```

and in `agentKnowledgeConfigSchema` add `imagens: z.array(agentImageItemSchema).max(20).default([]),`.

`packages/shared/src/schemas/agent.ts` — in `toolsConfigSchema`, after `update_qualification`:

```ts
  send_registered_image: z.boolean().default(false),
```

`packages/shared/src/prompt-builder.ts` — replace `compileKnowledgeSection` with:

```ts
function compileKnowledgeSection(knowledge: AgentKnowledgeConfig): string {
  const blocks: string[] = [];
  if (knowledge.precos_notas) {
    blocks.push(["# Preços", knowledge.precos_notas].join("\n"));
  }
  const activeLinks = knowledge.links.filter((l) => l.ativo);
  if (activeLinks.length > 0) {
    blocks.push(["# Links úteis", ...activeLinks.map((l) => `- ${l.titulo}: ${l.url}`)].join("\n"));
  }
  // The URL is deliberately left out: the model only ever refers to an image
  // by id, and sendRegisteredImage resolves the file itself.
  const activeImages = (knowledge.imagens ?? []).filter((i) => i.ativo);
  if (activeImages.length > 0) {
    blocks.push(
      [
        "# Imagens cadastradas",
        "Envie com a ferramenta sendRegisteredImage usando o id. Envie cada imagem no máximo uma vez por conversa, salvo se o cliente pedir de novo.",
        ...activeImages.map((i) => `- id: ${i.id} | ${i.titulo} | Quando enviar: ${i.quando_enviar}`),
      ].join("\n")
    );
  }
  return blocks.join("\n\n");
}
```

`packages/shared/src/agent-config-sections.ts` — in `SECTION_ITEMS.conhecimento` add `imagens: "Imagens",` after `links`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @aula-agente/shared test && pnpm --filter @aula-agente/shared typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Build shared (other packages consume `dist`) and commit**

```bash
pnpm --filter @aula-agente/shared build
git add packages/shared
git commit -m "feat(shared): add registered images to agent knowledge config"
```

---

### Task 2: Ferramenta `sendRegisteredImage` (`packages/agent-runtime`)

**Files:**
- Create: `packages/agent-runtime/src/tools/send-registered-image.ts`
- Create: `packages/agent-runtime/src/tools/send-registered-image.test.ts`
- Modify: `packages/agent-runtime/src/tools/registry.ts`
- Modify: `packages/agent-runtime/src/tools/registry.test.ts`

**Interfaces:**
- Consumes: `AgentImageItem`, `ToolsConfig.send_registered_image` (Task 1); `getLatestAgentVersion(client, agentId)`, `getAgentConfigIfExists(client, agentId)`, `createMessage`, `getAdminClient` from `@aula-agente/database`; `getSendMessageQueue` from `@aula-agente/queue`.
- Produces:
  - `type ImageLoader = () => Promise<AgentImageItem[]>`
  - `createSendRegisteredImageTool(context: { conversationId: string; organizationId: string; instanceId: string; phone: string }, loadImages: ImageLoader): Tool`
  - `createMockSendRegisteredImageTool(loadImages: ImageLoader): Tool`
  - `loadPublishedImages(agentId: string): Promise<AgentImageItem[]>`, `loadDraftImages(agentId: string): Promise<AgentImageItem[]>`
  - Registry key: `tools.sendRegisteredImage`

- [ ] **Step 1: Write the failing tests**

Create `packages/agent-runtime/src/tools/send-registered-image.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentImageItem } from "@aula-agente/shared";
import { createSendRegisteredImageTool, createMockSendRegisteredImageTool } from "./send-registered-image.js";

const createMessage = vi.fn();
const addToQueue = vi.fn();

vi.mock("@aula-agente/database", () => ({
  createMessage: (...args: unknown[]) => createMessage(...args),
  getAdminClient: () => ({}),
  getLatestAgentVersion: vi.fn(),
  getAgentConfigIfExists: vi.fn(),
}));

vi.mock("@aula-agente/queue", () => ({
  getSendMessageQueue: () => ({ add: (...args: unknown[]) => addToQueue(...args) }),
}));

const context = { conversationId: "conv-1", organizationId: "org-1", instanceId: "inst-1", phone: "5562999999999" };
const catalogo: AgentImageItem = {
  id: "img-1",
  titulo: "Catálogo Libera Cred",
  quando_enviar: "cliente pede o catálogo",
  legenda: "Motos do plano Libera Cred — preços de referência do plano (tabela 23/09/2026).",
  url: "https://x.test/storage/v1/object/public/agent-media/org-1/agent-1/img-1.png",
  storage_path: "org-1/agent-1/img-1.png",
  ativo: true,
};

beforeEach(() => {
  createMessage.mockReset();
  createMessage.mockResolvedValue({ id: "msg-1" });
  addToQueue.mockReset();
});

describe("createSendRegisteredImageTool", () => {
  it("sends the published image with its caption through the send-message queue", async () => {
    const toolDef = createSendRegisteredImageTool(context, async () => [catalogo]);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).toBe("Imagem enviada.");
    expect(createMessage).toHaveBeenCalledWith({}, expect.objectContaining({
      conversation_id: "conv-1", role: "agent", content: catalogo.legenda, media_url: catalogo.url, media_type: "image",
    }));
    expect(addToQueue).toHaveBeenCalledWith("send-message", expect.objectContaining({
      conversationId: "conv-1", messageId: "msg-1", mediaUrl: catalogo.url, mediaType: "image", caption: catalogo.legenda, phone: context.phone,
    }));
  });

  it("does not send and says so when the id is not in the published version (e.g. only in the draft)", async () => {
    const toolDef = createSendRegisteredImageTool(context, async () => []);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).not.toContain("Imagem enviada");
    expect(result).toContain("não diga ao cliente que enviou");
    expect(createMessage).not.toHaveBeenCalled();
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("does not send an inactive image", async () => {
    const toolDef = createSendRegisteredImageTool(context, async () => [{ ...catalogo, ativo: false }]);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).toContain("desativada");
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("reports a failure instead of claiming success when the queue throws", async () => {
    addToQueue.mockRejectedValue(new Error("redis down"));
    const toolDef = createSendRegisteredImageTool(context, async () => [catalogo]);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).not.toContain("Imagem enviada");
    expect(result).toContain("Não foi possível enviar");
  });
});

describe("createMockSendRegisteredImageTool", () => {
  it("simulates using the loaded (draft) images and never enqueues", async () => {
    const toolDef = createMockSendRegisteredImageTool(async () => [catalogo]);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).toContain("[SIMULADO]");
    expect(result).toContain("Catálogo Libera Cred");
    expect(createMessage).not.toHaveBeenCalled();
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("reports not-found in the simulation too", async () => {
    const toolDef = createMockSendRegisteredImageTool(async () => []);
    const result = await toolDef.execute!({ imagem_id: "nope" }, {} as never);
    expect(result).toContain("não diga ao cliente que enviou");
  });
});
```

Append to `packages/agent-runtime/src/tools/registry.test.ts` (inside the existing describe):

```ts
  it("registers sendRegisteredImage only when send_registered_image is on", () => {
    const off = buildToolsForAgent(baseParams);
    expect(off.sendRegisteredImage).toBeUndefined();

    const on = buildToolsForAgent({ ...baseParams, toolsConfig: { ...baseParams.toolsConfig, send_registered_image: true } });
    expect(on.sendRegisteredImage).toBeDefined();

    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true, toolsConfig: { ...baseParams.toolsConfig, send_registered_image: true } });
    expect(Object.keys(sandboxed).sort()).toEqual(Object.keys(on).sort());
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @aula-agente/agent-runtime test`
Expected: FAIL — cannot find module `./send-registered-image.js`.

- [ ] **Step 3: Implement**

Create `packages/agent-runtime/src/tools/send-registered-image.ts`:

```ts
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { AgentImageItem } from "@aula-agente/shared";
import { createMessage, getAdminClient, getAgentConfigIfExists, getLatestAgentVersion } from "@aula-agente/database";
import { getSendMessageQueue } from "@aula-agente/queue";

export type ImageLoader = () => Promise<AgentImageItem[]>;

interface SendRegisteredImageContext {
  conversationId: string;
  organizationId: string;
  instanceId: string;
  phone: string;
}

const DESCRIPTION =
  "Envia ao cliente, pelo WhatsApp, uma imagem cadastrada no Conhecimento (seção \"Imagens cadastradas\" do prompt). Use o id exato listado lá e só quando a situação de \"Quando enviar\" acontecer.";

const inputSchema = z.object({
  imagem_id: z.string().describe("id exato da imagem, como aparece em \"Imagens cadastradas\""),
});

// Customer-facing sends must only ever use what's published: an image added
// to the draft but not yet published doesn't exist for real conversations.
export async function loadPublishedImages(agentId: string): Promise<AgentImageItem[]> {
  const version = await getLatestAgentVersion(getAdminClient(), agentId);
  return version?.config_snapshot.knowledge.imagens ?? [];
}

// The playground tests the draft being edited, so it resolves from there.
export async function loadDraftImages(agentId: string): Promise<AgentImageItem[]> {
  const draft = await getAgentConfigIfExists(getAdminClient(), agentId);
  return draft?.knowledge.imagens ?? [];
}

type Resolution = { ok: true; image: AgentImageItem } | { ok: false; message: string };

async function resolveImage(loadImages: ImageLoader, imagemId: string): Promise<Resolution> {
  const image = (await loadImages()).find((i) => i.id === imagemId);
  if (!image) {
    return { ok: false, message: `Imagem "${imagemId}" não está cadastrada na versão publicada — não diga ao cliente que enviou.` };
  }
  if (!image.ativo) {
    return { ok: false, message: `Imagem "${image.titulo}" está desativada — não diga ao cliente que enviou.` };
  }
  return { ok: true, image };
}

export function createSendRegisteredImageTool(context: SendRegisteredImageContext, loadImages: ImageLoader): Tool {
  return tool({
    description: DESCRIPTION,
    inputSchema,
    execute: async ({ imagem_id }) => {
      try {
        const resolved = await resolveImage(loadImages, imagem_id);
        if (!resolved.ok) return resolved.message;
        const { image } = resolved;

        const message = await createMessage(getAdminClient(), {
          conversation_id: context.conversationId,
          organization_id: context.organizationId,
          evolution_message_id: null,
          role: "agent",
          content: image.legenda,
          media_url: image.url,
          media_type: "image",
          metadata: null,
        });

        await getSendMessageQueue().add("send-message", {
          conversationId: context.conversationId,
          messageId: message.id,
          instanceId: context.instanceId,
          phone: context.phone,
          content: image.legenda,
          mediaUrl: image.url,
          mediaType: "image",
          caption: image.legenda,
          organizationId: context.organizationId,
        });

        return "Imagem enviada.";
      } catch (err) {
        console.error("sendRegisteredImage tool failed:", err);
        return "Não foi possível enviar a imagem agora — não diga ao cliente que enviou.";
      }
    },
  });
}

export function createMockSendRegisteredImageTool(loadImages: ImageLoader): Tool {
  return tool({
    description: `${DESCRIPTION} Estamos no Playground de testes — nenhuma mensagem real é enviada.`,
    inputSchema,
    execute: async ({ imagem_id }) => {
      const resolved = await resolveImage(loadImages, imagem_id);
      if (!resolved.ok) return resolved.message;
      return `[SIMULADO] Imagem "${resolved.image.titulo}" seria enviada pelo WhatsApp agora, com a legenda: ${resolved.image.legenda}`;
    },
  });
}
```

In `packages/agent-runtime/src/tools/registry.ts` add the import:

```ts
import {
  createSendRegisteredImageTool,
  createMockSendRegisteredImageTool,
  loadDraftImages,
  loadPublishedImages,
} from "./send-registered-image.js";
```

and in `buildToolsForAgent`, after the `send_catalog_photo` block:

```ts
  if (toolsConfig.send_registered_image) {
    tools.sendRegisteredImage = sandbox
      ? createMockSendRegisteredImageTool(() => loadDraftImages(agentId))
      : createSendRegisteredImageTool({ conversationId, organizationId, instanceId, phone }, () => loadPublishedImages(agentId));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @aula-agente/agent-runtime test && pnpm --filter @aula-agente/agent-runtime typecheck`
Expected: PASS (existing registry cache-marker tests still pass: the new tool, when on, is just another entry).

- [ ] **Step 5: Build and commit**

```bash
pnpm --filter @aula-agente/agent-runtime build
git add packages/agent-runtime
git commit -m "feat(agent-runtime): add sendRegisteredImage tool"
```

---

### Task 3: Bucket e rota de upload (`supabase`, `apps/api`)

**Files:**
- Create: `supabase/migrations/00026_agent_media_bucket.sql`
- Create: `apps/api/src/services/agent-media.service.ts`
- Create: `apps/api/src/services/agent-media.service.test.ts`
- Create: `apps/api/src/routes/agent-config/images.ts`
- Create: `apps/api/src/routes/agent-config/images.test.ts`
- Modify: `apps/api/src/server.ts` (import + `server.register(agentImageRoutes)` next to `agentConfigRoutes`, ~linhas 13 e 44)

**Interfaces:**
- Consumes: `getAdminClient`, `getAgentById` from `@aula-agente/database`; `authMiddleware`.
- Produces:
  - `POST /organizations/:organizationId/agents/:agentId/config/images` (multipart, campo `file`) → `201 { id: string; url: string; storage_path: string }`; `400 { error }` formato inválido/sem arquivo; `403` sem permissão; `404` agente de outra org; `413` acima de 5 MB.
  - `detectImageExt(buf: Buffer): "png" | "jpg" | "webp" | null`
  - `uploadAgentImage(db, { organizationId, agentId, file }): Promise<{ id; url; storage_path }>`
  - `class InvalidImageError extends Error`

- [ ] **Step 1: Write the migration**

`supabase/migrations/00026_agent_media_bucket.sql`:

```sql
-- Public bucket for images the agent sends on WhatsApp (knowledge.imagens).
-- Public because Evolution API downloads the media from its URL. Writes go
-- only through the API with the service role, so no insert/update policy is
-- granted to authenticated/anon users.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agent-media', 'agent-media', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
```

- [ ] **Step 2: Write the failing tests**

`apps/api/src/services/agent-media.service.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { detectImageExt, uploadAgentImage, InvalidImageError, MAX_AGENT_IMAGE_BYTES } from "./agent-media.service.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
const PDF = Buffer.from("%PDF-1.7 fake");

function fakeDb(uploadError: unknown = null) {
  const upload = vi.fn().mockResolvedValue({ error: uploadError });
  const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://x.test/public/agent-media/${path}` } }));
  const from = vi.fn(() => ({ upload, getPublicUrl }));
  return { db: { storage: { from } } as never, upload, from };
}

describe("detectImageExt", () => {
  it("detects by file signature, not by name", () => {
    expect(detectImageExt(PNG)).toBe("png");
    expect(detectImageExt(JPG)).toBe("jpg");
    expect(detectImageExt(WEBP)).toBe("webp");
    expect(detectImageExt(PDF)).toBeNull();
  });
});

describe("uploadAgentImage", () => {
  it("stores under org/agent/uuid.ext in agent-media and returns the public URL", async () => {
    const { db, upload, from } = fakeDb();
    const result = await uploadAgentImage(db, { organizationId: "org-1", agentId: "agent-1", file: PNG });

    expect(from).toHaveBeenCalledWith("agent-media");
    expect(result.storage_path).toMatch(/^org-1\/agent-1\/[0-9a-f-]{36}\.png$/);
    expect(result.id).toBe(result.storage_path.split("/")[2].replace(".png", ""));
    expect(result.url).toBe(`https://x.test/public/agent-media/${result.storage_path}`);
    expect(upload).toHaveBeenCalledWith(result.storage_path, PNG, { contentType: "image/png", upsert: false });
  });

  it("rejects a non-image even if it would be named .png", async () => {
    const { db, upload } = fakeDb();
    await expect(uploadAgentImage(db, { organizationId: "o", agentId: "a", file: PDF })).rejects.toBeInstanceOf(InvalidImageError);
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects files over 5 MB", async () => {
    const { db } = fakeDb();
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_AGENT_IMAGE_BYTES)]);
    await expect(uploadAgentImage(db, { organizationId: "o", agentId: "a", file: big })).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("propagates storage errors", async () => {
    const { db } = fakeDb(new Error("bucket not found"));
    await expect(uploadAgentImage(db, { organizationId: "o", agentId: "a", file: PNG })).rejects.toThrow("bucket not found");
  });
});
```

`apps/api/src/routes/agent-config/images.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { getAdminClient, getAgentById, uploadAgentImage } = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  getAgentById: vi.fn(),
  uploadAgentImage: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ getAdminClient, getAgentById }));
vi.mock("../../services/agent-media.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/agent-media.service.js")>()),
  uploadAgentImage,
}));

let role = "admin";
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { id: "user-1", email: "u@example.com", memberships: [{ organization_id: "org-1", role }] };
  },
}));

import agentImageRoutes from "./images.js";
import { InvalidImageError } from "../../services/agent-media.service.js";

const URL_ = "/organizations/org-1/agents/agent-1/config/images";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function multipart(file: Buffer | null) {
  const boundary = "----testboundary";
  const parts = file
    ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="catalogo.png"\r\nContent-Type: image/png\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`)]
    : [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nx\r\n--${boundary}--\r\n`)];
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(agentImageRoutes);
  await app.ready();
  return app;
}

describe("POST agent config images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role = "admin";
    getAgentById.mockResolvedValue({ id: "agent-1", organization_id: "org-1" });
  });

  it("uploads and returns 201 with id/url/storage_path", async () => {
    uploadAgentImage.mockResolvedValue({ id: "u1", url: "https://x.test/a.png", storage_path: "org-1/agent-1/u1.png" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(PNG) });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: "u1", url: "https://x.test/a.png", storage_path: "org-1/agent-1/u1.png" });
    expect(uploadAgentImage).toHaveBeenCalledWith({}, { organizationId: "org-1", agentId: "agent-1", file: PNG });
  });

  it("returns 400 without a file", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(null) });
    expect(res.statusCode).toBe(400);
    expect(uploadAgentImage).not.toHaveBeenCalled();
  });

  it("returns 400 with the service's message for an invalid image", async () => {
    uploadAgentImage.mockRejectedValue(new InvalidImageError("Formato não suportado: envie PNG, JPG ou WebP."));
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(PNG) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("PNG, JPG ou WebP");
  });

  it("returns 404 when the agent belongs to another organization", async () => {
    getAgentById.mockResolvedValue({ id: "agent-1", organization_id: "org-2" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(PNG) });
    expect(res.statusCode).toBe(404);
    expect(uploadAgentImage).not.toHaveBeenCalled();
  });

  it("returns 403 for the agent role", async () => {
    role = "agent";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(PNG) });
    expect(res.statusCode).toBe(403);
  });

  it("returns 413 above 5 MB", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])) });
    expect(res.statusCode).toBe(413);
    expect(uploadAgentImage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @aula-agente/api test -- agent-media images`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`apps/api/src/services/agent-media.service.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@aula-agente/database";

export const AGENT_MEDIA_BUCKET = "agent-media";
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;

export type AgentImageExt = "png" | "jpg" | "webp";

const CONTENT_TYPES: Record<AgentImageExt, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export class InvalidImageError extends Error {}

// Checked by content signature, not by file name or the browser-supplied
// MIME type, so a renamed PDF can't end up being sent to customers.
export function detectImageExt(buf: Buffer): AgentImageExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

export async function uploadAgentImage(
  db: SupabaseClient,
  params: { organizationId: string; agentId: string; file: Buffer }
): Promise<{ id: string; url: string; storage_path: string }> {
  if (params.file.length > MAX_AGENT_IMAGE_BYTES) {
    throw new InvalidImageError("Imagem acima de 5 MB.");
  }
  const ext = detectImageExt(params.file);
  if (!ext) {
    throw new InvalidImageError("Formato não suportado: envie PNG, JPG ou WebP.");
  }

  const id = randomUUID();
  const storagePath = `${params.organizationId}/${params.agentId}/${id}.${ext}`;
  const bucket = db.storage.from(AGENT_MEDIA_BUCKET);
  const { error } = await bucket.upload(storagePath, params.file, { contentType: CONTENT_TYPES[ext], upsert: false });
  if (error) throw error;

  return { id, url: bucket.getPublicUrl(storagePath).data.publicUrl, storage_path: storagePath };
}
```

`apps/api/src/routes/agent-config/images.ts`:

```ts
import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { getAdminClient, getAgentById } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { InvalidImageError, MAX_AGENT_IMAGE_BYTES, uploadAgentImage } from "../../services/agent-media.service.js";

// Only stores the file. The panel then adds/updates the item in the draft's
// knowledge.imagens through the normal draft PATCH, so the image goes live
// only when the draft is published.
export default async function agentImageRoutes(app: FastifyInstance) {
  app.register(multipart, { limits: { fileSize: MAX_AGENT_IMAGE_BYTES, files: 1 } });
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { organizationId: string; agentId: string } }>(
    "/organizations/:organizationId/agents/:agentId/config/images",
    async (request, reply) => {
      const { organizationId, agentId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId && m.role !== "agent"
      );
      if (!membership) return reply.status(403).send({ error: "Admin access required" });

      const db = getAdminClient();
      const agent = await getAgentById(db, agentId).catch(() => null);
      if (!agent || agent.organization_id !== organizationId) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const data = await request.file();
      if (!data) return reply.status(400).send({ error: "Nenhum arquivo enviado." });

      let file: Buffer;
      try {
        file = await data.toBuffer();
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.status(413).send({ error: "Imagem acima de 5 MB." });
        }
        throw err;
      }

      try {
        const stored = await uploadAgentImage(db, { organizationId, agentId, file });
        return reply.status(201).send(stored);
      } catch (err) {
        if (err instanceof InvalidImageError) return reply.status(400).send({ error: err.message });
        throw err;
      }
    }
  );
}
```

`apps/api/src/server.ts`: add `import agentImageRoutes from "./routes/agent-config/images.js";` next to the `agentConfigRoutes` import and `server.register(agentImageRoutes);` right after `server.register(agentConfigRoutes);`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/api typecheck`
Expected: PASS. If `request.file()` returns `undefined` rather than throwing for a form without file parts, the 400 test covers it; if the 413 test gets 500, check the thrown error's `code` with a `console.log` and match it (the `@fastify/multipart` v9 code is `FST_REQ_FILE_TOO_LARGE`).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00026_agent_media_bucket.sql apps/api/src/services/agent-media.service.ts apps/api/src/services/agent-media.service.test.ts apps/api/src/routes/agent-config/images.ts apps/api/src/routes/agent-config/images.test.ts apps/api/src/server.ts
git commit -m "feat(api): add agent-media bucket and image upload route"
```

---

### Task 4: Painel — editor de Imagens e chave em Ferramentas (`apps/web`)

**Files:**
- Create: `apps/web/src/components/agents/config/imagens-editor.tsx`
- Modify: `apps/web/src/components/agents/config/conhecimento-section.tsx` (tipo `ConhecimentoItemKey` linha 14; novo ramo `item === "imagens"` antes do ramo de Links)
- Modify: `apps/web/src/components/agents/config/ferramentas-section.tsx` (`ToolRow.key` linha 12 e `TOOL_ROWS` linhas 17-23)

**Interfaces:**
- Consumes: `AgentImageItem`, `SECTION_ITEMS.conhecimento.imagens` (Task 1); rota `POST .../config/images` (Task 3).
- Produces: `ImagensEditor({ agentId, imagens, onChange }: { agentId: string; imagens: AgentImageItem[]; onChange: (items: AgentImageItem[]) => void })`.

`apps/web` has no test runner; verification is typecheck + build + manual check against a **local API** (not production — see Global Constraints).

- [ ] **Step 1: Create the editor**

`apps/web/src/components/agents/config/imagens-editor.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Trash2, Upload } from "lucide-react";
import type { AgentImageItem } from "@aula-agente/shared";

interface ImagensEditorProps {
  agentId: string;
  imagens: AgentImageItem[];
  onChange: (items: AgentImageItem[]) => void;
}

type StoredImage = { id: string; url: string; storage_path: string };

async function uploadImage(organizationId: string, agentId: string, file: File): Promise<StoredImage> {
  const formData = new FormData();
  formData.append("file", file);
  const { createClient } = await import("@/lib/supabase/client");
  const { data: { session } } = await createClient().auth.getSession();
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const response = await fetch(`${API_URL}/organizations/${organizationId}/agents/${agentId}/config/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session?.access_token}` },
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Falha no upload da imagem");
  }
  return response.json();
}

export function ImagensEditor({ agentId, imagens, onChange }: ImagensEditorProps) {
  const { currentOrg } = useOrganization();
  // Text fields edit local state and only save on blur, like the rest of the
  // config editor — saving per keystroke races overlapping PATCHes.
  const [items, setItems] = useState(imagens);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  const commit = (next: AgentImageItem[]) => {
    setItems(next);
    onChange(next);
  };
  const setField = (id: string, patch: Partial<AgentImageItem>) =>
    setItems(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = replaceTarget.current;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file || !currentOrg) return;
    setBusy(target ?? "new");
    try {
      const stored = await uploadImage(currentOrg.id, agentId, file);
      if (target) {
        // Keep the item's id (it's what the prompt and the model refer to);
        // only the file behind it changes.
        commit(items.map((i) => (i.id === target ? { ...i, url: stored.url, storage_path: stored.storage_path } : i)));
      } else {
        commit([...items, { id: stored.id, titulo: file.name, quando_enviar: "", legenda: "", url: stored.url, storage_path: stored.storage_path, ativo: false }]);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro no upload");
    } finally {
      setBusy(null);
      replaceTarget.current = null;
    }
  };

  const pickFile = (target: string | null) => {
    replaceTarget.current = target;
    fileInputRef.current?.click();
  };

  return (
    <div className="space-y-4">
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleFile} />
      {items.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma imagem cadastrada.</p>}
      {items.map((img) => (
        <div key={img.id} className="flex gap-4 rounded-md border p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.url} alt={img.titulo} className="h-28 w-28 shrink-0 rounded object-contain bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Input value={img.titulo} maxLength={150} placeholder="Título" onChange={(e) => setField(img.id, { titulo: e.target.value })} onBlur={() => commit(items)} />
              <div className="flex items-center gap-2">
                <Label className="text-xs">Ativa</Label>
                <Switch checked={img.ativo} onCheckedChange={(v) => commit(items.map((i) => (i.id === img.id ? { ...i, ativo: v } : i)))} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Quando enviar</Label>
              <Textarea rows={2} maxLength={500} value={img.quando_enviar} placeholder="Ex.: cliente pede o catálogo do Libera Cred" onChange={(e) => setField(img.id, { quando_enviar: e.target.value })} onBlur={() => commit(items)} />
            </div>
            <div>
              <Label className="text-xs">Legenda enviada no WhatsApp</Label>
              <Textarea rows={2} maxLength={1000} value={img.legenda} onChange={(e) => setField(img.id, { legenda: e.target.value })} onBlur={() => commit(items)} />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => pickFile(img.id)}>
                {busy === img.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}Trocar arquivo
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => commit(items.filter((i) => i.id !== img.id))}>
                <Trash2 className="mr-1 h-4 w-4" />Remover
              </Button>
            </div>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" disabled={busy !== null || items.length >= 20} onClick={() => pickFile(null)}>
        {busy === "new" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}Adicionar imagem
      </Button>
      <p className="text-xs text-muted-foreground">PNG, JPG ou WebP até 5 MB. Imagens novas entram desativadas; a Helena só usa depois de publicar.</p>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into Conhecimento**

In `conhecimento-section.tsx`:
- change line 14 to `export type ConhecimentoItemKey = "documentos" | "faq" | "precos" | "links" | "imagens";`
- add `import { ImagensEditor } from "./imagens-editor";`
- insert before the final `return (` (the Links card):

```tsx
  if (item === "imagens") {
    return (
      <Card>
        <CardHeader><CardTitle>Imagens</CardTitle></CardHeader>
        <CardContent>
          <ImagensEditor
            agentId={agentId}
            imagens={knowledge.imagens ?? []}
            onChange={(items) => save({ ...knowledge, imagens: items })}
          />
        </CardContent>
      </Card>
    );
  }
```

- [ ] **Step 3: Add the Ferramentas switch**

In `ferramentas-section.tsx`:
- line 12: `key: "search_knowledge" | "search_faq" | "send_catalog_photo" | "send_registered_image" | "create_task" | "update_qualification";`
- in `TOOL_ROWS`, after the `send_catalog_photo` row:

```ts
  { key: "send_registered_image", title: "Enviar imagens cadastradas", description: "Permite ao agente enviar as imagens cadastradas em Conhecimento → Imagens pelo WhatsApp" },
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @aula-agente/web typecheck && pnpm --filter @aula-agente/web build`
Expected: no errors. Then, with `pnpm dev:api` **locally** and `NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm dev:web` against a non-production Supabase if available — otherwise skip the manual check and note it for the rollout (Task 5 does the real check in production with approval). Manual check: Conhecimento → Imagens aparece na árvore; adicionar imagem mostra miniatura desativada; editar título/quando enviar/legenda e sair do campo salva; Ferramentas mostra a nova chave.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agents/config/imagens-editor.tsx apps/web/src/components/agents/config/conhecimento-section.tsx apps/web/src/components/agents/config/ferramentas-section.tsx
git commit -m "feat(web): add registered images editor and tool switch"
```

- [ ] **Step 6: Full check before handoff**

Run: `pnpm test && pnpm typecheck`
Expected: all packages PASS. Then request code review (superpowers:requesting-code-review) before merging.

---

### Task 5: Rollout em produção (cada passo com aprovação explícita do usuário)

**Files:** nenhum arquivo do repo; operações em produção.

- [ ] **Step 1: Merge e deploy** — após review, merge `feat/imagens-cadastradas` em `main` e deploy de api, worker e web conforme `docs/operations/deployment.md`. **Pedir aprovação antes.** O worker precisa do novo `agent-runtime` (a ferramenta roda no `process-message`).

- [ ] **Step 2: Aplicar a migração 00026** no Supabase de produção. **Pedir aprovação antes.** Verificar: `select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'agent-media';` → 1 linha, `public = true`, `5242880`.

- [ ] **Step 3: Cadastrar a arte** `~/Downloads/catalogo_motos_plano.png` (13 preços conferidos com a tabela de 23/09/2026 em 2026-09-27) pelo painel (Conhecimento → Imagens) ou pela rota de upload, e preencher no rascunho:
  - Título: `Catálogo Libera Cred`
  - Quando enviar: `cliente pede o catálogo, todas as motos ou as opções do Libera Cred`
  - Legenda: `Motos do plano Libera Cred — preços de referência do plano (tabela 23/09/2026). A parcela depende do prazo escolhido.`
  - Ativa: sim

- [ ] **Step 4: Regra no rascunho** — acrescentar ao fim da regra `liberacred-apresentacao-modelos` (hoje ~1100 caracteres; limite 2000):

```
Imagem "Catálogo Libera Cred": ao enviá-la, informar em texto a parcela do prazo em discussão (ou do 12x como referência) pela tabela da Base de Conhecimento. Os valores da arte são o preço de referência do plano, não preço à vista nem parcela. Se a tabela mudar, a arte precisa ser trocada na mesma publicação. Para um modelo específico, preferir a foto do catálogo do modelo em vez da arte inteira.
```

E ligar `tools_config.send_registered_image = true` (Ferramentas).

- [ ] **Step 5: Validar no playground (rascunho)** — conversas: "me manda o catálogo do Libera Cred" (deve chamar `sendRegisteredImage` e informar parcelas em texto), "quais motos tem no Libera Cred?" (envia a arte e/ou lista os 13 agrupados, sem inventar preço), "manda foto da Lander" (deve usar `sendVehiclePhoto`, não a arte). Conferir que nenhuma resposta trata R$ 34.562,20 como preço à vista.

- [ ] **Step 6: Publicar** pelo editor (ou `publishAgentConfig`) com changelog descrevendo imagem + regra + chave. **Pedir aprovação antes.** Conferir que o diff mostra só Conhecimento, Regras e Ferramentas.
