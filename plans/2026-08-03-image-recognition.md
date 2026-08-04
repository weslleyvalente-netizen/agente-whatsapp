# Image Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Describe WhatsApp photos in text so the agent can respond to them like any other message, instead of only seeing the `[imagem]` placeholder (or bare caption) it gets today.

**Architecture:** The webhook keeps saving the placeholder/caption exactly as today (fast ack, unchanged — no webhook or schema changes needed, unlike the audio feature, since `imageMessage.caption` extraction already exists). The worker's `process-message` job — which already resolves `agent`/`apiKey` and already has an analogous `media_type === "audio"` branch — gets a sibling `media_type === "image"` branch: it fetches the photo from Evolution API, sends it to a vision-capable call using the **organization's own already-configured chat provider/model** (not a new fixed provider — all three supported providers handle vision), overwrites the message's stored content with the generated description (so it shows in the Inbox too), and only then runs the agent. Any failure anywhere in that chain (Evolution fetch error, model doesn't support vision, image over the size cap, empty description) sends a fixed "couldn't analyze this image" reply and skips the LLM entirely, mirroring the audio branch's failure handling exactly.

**Tech Stack:** Native `fetch` (Evolution download, same as audio), `generateText` from the `ai` package (v7.0.18, already a direct dependency of `apps/worker`) for the vision call, `createModel` from `@aula-agente/agent-runtime` (already exported, already used by `runAgent`) to build the model instance, vitest for the two pure helpers this feature introduces.

## Global Constraints

- Confirmed contracts, use exactly these — do not re-derive or guess:
  - Fetch image: `POST {EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/{instanceName}`, header `apikey: {EVOLUTION_API_KEY}`, JSON body `{ "message": { "key": { "id": "<evolutionMessageId>" } } }` — no `convertToMp4` flag (that's audio/video-only). Response: `{ mediaType, fileName, caption, size, mimetype, base64 }`, same shape as the audio feature's confirmed contract for this endpoint.
  - Multimodal content part shape, confirmed against the installed `ai@7.0.18` / `@ai-sdk/provider-utils@5.0.6` type declarations: a user message's `content` array accepts `{ type: "file", mediaType: string, data: <base64 string> }` for inline image bytes (the current, non-deprecated shape — `ImagePart`/`type: "image"` is marked `@deprecated` in the installed version in favor of this `FilePart` form). Use this exact shape, not `type: "image"`.
- **No new provider/key to manage** (deviation from the audio precedent, decided in spec): the vision call reuses `agent.provider` / `agent.model` / the `apiKey` that `process-message.ts` already resolves via `resolveApiKey(organizationId, agent.provider)` earlier in the function — zero additional key resolution.
- **Size cap: 10 MB**, enforced by decoding the base64 response to a `Buffer` and checking `buffer.length` — **not** by trusting a `size` field in Evolution's response (the spec assumed that field's exact shape but it was never confirmed live for images; checking the decoded buffer directly is simpler and needs no assumption about Evolution's response shape). Over the cap: skip the vision call entirely and go straight to the fallback.
- Fallback text on any failure (Evolution error, size cap, model/vision error, empty description): exactly `"Desculpa, não consegui analisar essa imagem 🙏 Pode me contar em texto o que tem nela?"` — sent directly, bypassing the LLM, same mechanism (`sendFallbackText`) the audio branch already uses.
- Generated description overwrites the message's stored content, prefixed with `"📷 "` (camera emoji + space), mirroring the audio branch's `"🎤 "` prefix.
- No per-agent/organization opt-in toggle — runs automatically for every incoming image, unconditionally. (spec Non-goals)
- No keeping the image "alive" for follow-up questions, no OCR-specific handling, no dashboard image display — one-shot text description only. (spec Non-goals)
- Already exist, reuse as-is, no changes needed: `updateMessageContent(client, id, content)` in `packages/database/src/queries/messages.ts`; `media_type: "image"` and caption extraction in the webhook/schema; the dashboard's realtime `onUpdate` wiring in `chat-panel.tsx` (all three already shipped by the audio feature).

---

### Task 1: Image description module

**Files:**
- Create: `apps/worker/src/lib/image-description.ts`
- Test: `apps/worker/src/lib/image-description.test.ts`

**Interfaces:**
- Consumes: `createModel(provider: LLMProvider, modelName: string, apiKey: string): LanguageModel` from `@aula-agente/agent-runtime` (already exported, already used by `agent-runner.ts`). `process.env.EVOLUTION_API_URL` / `process.env.EVOLUTION_API_KEY` (already used the same way in `audio-transcription.ts`). `generateText` from `ai`.
- Produces: `describeImageMessage(params: { instanceName: string; evolutionMessageId: string; caption?: string; provider: LLMProvider; model: string; apiKey: string }): Promise<{ ok: true; text: string } | { ok: false; reason: string }>` — Task 2 calls this directly and branches on `.ok`. Also exports two pure helpers, each independently unit-tested: `buildImageDescriptionPrompt(caption?: string): string` and `exceedsSizeCap(byteLength: number): boolean`.

Unlike `transcribeAudioMessage`, the API key is **not** resolved inside this function — it's passed in already-resolved (`process-message.ts` already has it in scope for `agent.provider`, and there's no separate "vision provider" to resolve here, unlike audio's OpenAI-specific key).

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/lib/image-description.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildImageDescriptionPrompt, exceedsSizeCap } from "./image-description.js";

describe("buildImageDescriptionPrompt", () => {
  it("returns the base prompt when there is no caption", () => {
    const prompt = buildImageDescriptionPrompt();
    expect(prompt).toContain("Descreva em português");
    expect(prompt).not.toContain("escreveu junto");
  });

  it("appends the caption as extra context when present", () => {
    const prompt = buildImageDescriptionPrompt("quanto vale essa?");
    expect(prompt).toContain("Descreva em português");
    expect(prompt).toContain('"quanto vale essa?"');
  });
});

describe("exceedsSizeCap", () => {
  it("returns false for an image under 10 MB", () => {
    expect(exceedsSizeCap(5 * 1024 * 1024)).toBe(false);
  });

  it("returns false for exactly 10 MB", () => {
    expect(exceedsSizeCap(10 * 1024 * 1024)).toBe(false);
  });

  it("returns true for an image over 10 MB", () => {
    expect(exceedsSizeCap(10 * 1024 * 1024 + 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/worker && pnpm exec vitest run src/lib/image-description.test.ts`
Expected: FAIL with "Failed to resolve import ./image-description.js" (file doesn't exist yet).

- [ ] **Step 3: Create the module**

Create `apps/worker/src/lib/image-description.ts`:

```ts
import { generateText } from "ai";
import { createModel } from "@aula-agente/agent-runtime";
import type { LLMProvider } from "@aula-agente/shared";

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;
const IMAGE_SIZE_CAP_BYTES = 10 * 1024 * 1024;

interface EvolutionMediaResponse {
  base64: string;
  mimetype: string;
}

async function fetchImage(instanceName: string, evolutionMessageId: string): Promise<EvolutionMediaResponse> {
  const response = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      message: { key: { id: evolutionMessageId } },
    }),
  });

  if (!response.ok) {
    throw new Error(`Evolution media fetch error ${response.status}`);
  }

  const data = await response.json();
  return { base64: data.base64, mimetype: data.mimetype };
}

export function exceedsSizeCap(byteLength: number): boolean {
  return byteLength > IMAGE_SIZE_CAP_BYTES;
}

// Kept short on purpose: this becomes part of the conversation history the
// agent reads on every future turn, so a verbose description would eat
// context budget for the rest of the conversation's lifetime.
export function buildImageDescriptionPrompt(caption?: string): string {
  const base =
    "Descreva em português o que aparece nesta imagem, como se estivesse " +
    "contando pra alguém que não pode vê-la. Se for uma moto, identifique " +
    "marca, modelo, cor e estado aparente (arranhões, amassados, pneus etc.) " +
    "quando der pra notar. Seja direto, no máximo 2-3 frases.";

  if (!caption) return base;
  return `${base}\n\nA pessoa que mandou a imagem escreveu junto: "${caption}"`;
}

export type ImageDescriptionResult = { ok: true; text: string } | { ok: false; reason: string };

export async function describeImageMessage(params: {
  instanceName: string;
  evolutionMessageId: string;
  caption?: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
}): Promise<ImageDescriptionResult> {
  try {
    const { base64, mimetype } = await fetchImage(params.instanceName, params.evolutionMessageId);
    const byteLength = Buffer.byteLength(base64, "base64");

    if (exceedsSizeCap(byteLength)) {
      return { ok: false, reason: "image_too_large" };
    }

    const model = createModel(params.provider, params.model, params.apiKey);

    const result = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildImageDescriptionPrompt(params.caption) },
            { type: "file", mediaType: mimetype, data: base64 },
          ],
        },
      ],
    });

    if (!result.text.trim()) {
      return { ok: false, reason: "empty_description" };
    }

    return { ok: true, text: result.text.trim() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && pnpm exec vitest run src/lib/image-description.test.ts`
Expected: PASS (5 tests).

Then typecheck:

Run: `cd apps/worker && pnpm exec tsc --noEmit`
Expected: no type errors. (If `{ type: "file", mediaType, data: base64 }` doesn't typecheck against the installed `ai` version's `ModelMessage`/`UserContent` type, that's a signal the installed version differs from what Step 3 above assumes — check `node_modules/.pnpm/@ai-sdk+provider-utils@*/node_modules/@ai-sdk/provider-utils/dist/index.d.ts` for the current `FilePart`/`ImagePart` shape and adjust the content-part literal to match before proceeding.)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/image-description.ts apps/worker/src/lib/image-description.test.ts
git commit -m "feat: add image description module (Evolution fetch + vision model)"
```

---

### Task 2: Wire image description into process-message

**Files:**
- Modify: `apps/worker/src/workers/process-message.ts`

**Interfaces:**
- Consumes: `describeImageMessage` and `ImageDescriptionResult` from Task 1 (`../lib/image-description.js`). `agent.provider`, `agent.model`, `apiKey` — all already in scope in this function (resolved earlier, before the audio branch).

This task's own correctness (the BullMQ job branching, the live Evolution/vision-model calls) is verified manually against the real running services, not with a unit test — matching this file's existing precedent (it has no test file today, same as the audio branch's wiring).

- [ ] **Step 1: Add the import and the fallback text constant**

In `apps/worker/src/workers/process-message.ts`, change line 12 from:

```ts
import { transcribeAudioMessage } from "../lib/audio-transcription.js";
```

to:

```ts
import { transcribeAudioMessage } from "../lib/audio-transcription.js";
import { describeImageMessage } from "../lib/image-description.js";
```

Then change lines 14-16 from:

```ts
const AUDIO_DURATION_CAP_SECONDS = 300;
const AUDIO_FALLBACK_TEXT =
  "Desculpa, não consegui entender esse áudio 🙏 Pode escrever a mensagem, por favor?";
```

to:

```ts
const AUDIO_DURATION_CAP_SECONDS = 300;
const AUDIO_FALLBACK_TEXT =
  "Desculpa, não consegui entender esse áudio 🙏 Pode escrever a mensagem, por favor?";
const IMAGE_FALLBACK_TEXT =
  "Desculpa, não consegui analisar essa imagem 🙏 Pode me contar em texto o que tem nela?";
```

- [ ] **Step 2: Add the image branch right after the audio branch**

The audio branch currently ends at line 140 (the closing `}` of `if (currentMessage.media_type === "audio") { ... }`), immediately followed by a blank line and the `// Remove current message from history` comment. Insert a new `if` block for images in between, so this exact excerpt:

```ts
          const transcribedContent = `🎤 ${transcription.text}`;
          await updateMessageContent(db, currentMessage.id, transcribedContent);
          effectiveMessage = { ...currentMessage, content: transcribedContent };
        }

        // Remove current message from history
```

becomes:

```ts
          const transcribedContent = `🎤 ${transcription.text}`;
          await updateMessageContent(db, currentMessage.id, transcribedContent);
          effectiveMessage = { ...currentMessage, content: transcribedContent };
        }

        // Photos arrive with a "[imagem]" placeholder (or just the caption,
        // if the customer wrote one) — describe the actual image content
        // before the agent ever sees it, same reasoning as the audio branch
        // above: it's a pipeline step that runs here in the worker, not the
        // webhook, so the webhook keeps acking Evolution fast regardless of
        // how long the vision call takes.
        if (currentMessage.media_type === "image") {
          const caption = currentMessage.content === "[imagem]" ? undefined : currentMessage.content;

          const description = await describeImageMessage({
            instanceName: instance.instance_name,
            evolutionMessageId: currentMessage.evolution_message_id!,
            caption,
            provider: agent.provider,
            model: agent.model,
            apiKey,
          });

          if (!description.ok) {
            console.log(`Message ${messageId} image description failed: ${description.reason}`);
            await sendFallbackText(db, IMAGE_FALLBACK_TEXT, {
              conversationId,
              organizationId,
              instanceId: instance.id,
              phone,
            });
            return;
          }

          const describedContent = `📷 ${description.text}`;
          await updateMessageContent(db, currentMessage.id, describedContent);
          effectiveMessage = { ...currentMessage, content: describedContent };
        }

        // Remove current message from history
```

- [ ] **Step 3: Typecheck and run the full worker test suite**

Run: `cd apps/worker && pnpm exec tsc --noEmit`
Expected: no type errors.

Run: `cd apps/worker && pnpm exec vitest run`
Expected: PASS — all existing tests plus Task 1's `image-description.test.ts`. This task's own change has no test of its own (I/O-heavy BullMQ handler, matches this file's existing untested precedent for the audio branch).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/workers/process-message.ts
git commit -m "feat: describe incoming photos before the agent responds"
```

- [ ] **Step 5: Deploy and verify live**

This task changes `apps/worker` only — redeploy it (however this project's worker service is deployed/rebuilt).

Then verify two ways:

1. **Size-cap and failure paths** (can be simulated without a real photo): temporarily lower `IMAGE_SIZE_CAP_BYTES` in a local build, or POST a synthetic webhook to `/webhooks/evolution` for the safe test number with `messageType: "imageMessage"` referencing an `evolutionMessageId` that doesn't exist in Evolution's store (so the fetch itself fails) — confirm the conversation receives the exact `IMAGE_FALLBACK_TEXT` and no LLM call happens (check worker logs for `"image description failed"` and confirm no `"Processed message ... -> response ..."` log line for that message).
2. **Real description** (cannot be simulated — `getBase64FromMediaMessage` looks up a real message in Evolution's own store by id, so it needs a photo Evolution actually received): send a real WhatsApp photo — including one of an actual motorcycle — to the safe test number's connected instance, then check the conversation's messages for the `📷 <description>`-prefixed content, confirm it correctly calls out brand/model/color when it's a motorcycle photo, and confirm the agent's reply is coherent with the description.

---

## Post-plan note (not a task)

If any organization's configured `agent.model` doesn't support vision, every photo sent to that organization's agent will fall back to `IMAGE_FALLBACK_TEXT` (never crash, per the try/catch in `describeImageMessage`) — but no description will ever succeed for that org. This is expected per the spec ("no new provider/model to manage") but worth watching for in worker logs (`"image description failed"` with a model/provider error as the reason) after this ships, in case a specific organization's model choice needs to change.
