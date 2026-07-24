# Audio Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe WhatsApp voice notes to text so the agent can respond to them like any other message, instead of only seeing an `[audio]` placeholder.

**Architecture:** The webhook keeps saving `[audio]` exactly as today (fast ack, unchanged). The worker's `process-message` job — which already runs per-message in the background before calling the LLM — detects `media_type === "audio"`, fetches the voice note from Evolution API (asking it to convert to MP4 server-side, since raw WhatsApp OGG/Opus is unreliable with OpenAI's transcription API), transcribes it with OpenAI Whisper, overwrites the message's stored content with the transcript (so it shows in the Inbox too), and only then runs the agent — using the transcript as if the customer had typed it. Any failure anywhere in that chain (including a missing OpenAI key) sends a fixed "please type instead" reply and skips the LLM entirely, rather than crashing the job or guessing.

**Tech Stack:** Native `fetch`/`FormData`/`Blob` (Node 22, already used by `search-catalog.ts` and `send-message.ts` — no new dependency), vitest for the one pure helper this feature introduces, BullMQ (existing `process-message` worker).

## Global Constraints

- Confirmed live/documented contracts, use exactly these — do not re-derive or guess:
  - Fetch audio: `POST {EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/{instanceName}`, header `apikey: {EVOLUTION_API_KEY}`, JSON body `{ "message": { "key": { "id": "<evolutionMessageId>" } }, "convertToMp4": true }`. Response: `{ mediaType, fileName, caption, size, mimetype: "audio/mp4", base64 }`.
  - Transcribe: `POST https://api.openai.com/v1/audio/transcriptions`, header `Authorization: Bearer {OPENAI_API_KEY}`, `multipart/form-data` with fields `file` (audio binary), `model=whisper-1`, `language=pt`. Response: `{ "text": "<transcript>" }`.
  - Voice note duration arrives in the original webhook payload at `data.message.audioMessage.seconds` — no extra API call needed to know it.
- No local ffmpeg/transcoding dependency — Evolution's `convertToMp4: true` does this server-side. Do not add ffmpeg to any Dockerfile.
- No per-agent opt-in toggle — this applies to every agent/organization unconditionally, unlike `tools_config` flags. (spec Non-goals)
- Duration cap: voice notes longer than **300 seconds (5 minutes)** skip transcription entirely and get the same "please type" fallback, checked from the webhook-provided duration before any external call. (spec, "Duration cap")
- Fallback text on any failure (missing key, fetch error, transcription error, empty transcript, or duration cap): exactly `"Desculpa, não consegui entender esse áudio 🙏 Pode escrever a mensagem, por favor?"` — sent directly, bypassing the LLM. (spec, decided by user)
- Transcribed text overwrites the message's stored content, prefixed with `"🎤 "` (mic emoji + space), so it's visible in the Inbox and distinguishable from a typed message. (spec, decided by user)

---

### Task 1: Capture voice note duration through the webhook

**Files:**
- Modify: `packages/shared/src/schemas/evolution.ts`
- Modify: `packages/shared/src/types/message.ts`
- Modify: `apps/api/src/routes/webhooks/evolution.ts`
- Test: `apps/api/src/routes/webhooks/evolution.test.ts`

**Interfaces:**
- Produces: `extractMessageContent(data)` returns `{ content: string; mediaType: string | null; durationSeconds?: number }` (adds one optional field to its existing return shape — `durationSeconds` is only ever set for `audioMessage`). Task 3 does not consume this directly, but the webhook handler passes it into `saveMessage`'s existing `metadata` param as `{ duration_seconds }`, and Task 3's code reads `currentMessage.metadata?.duration_seconds`.

- [ ] **Step 1: Write the failing tests**

Open `apps/api/src/routes/webhooks/evolution.test.ts` and add these two cases inside the existing `describe("extractMessageContent", ...)` block, right after the `"falls back to a placeholder for an unhandled message type"` test:

```ts
  it("passes through the voice note duration for audio messages", () => {
    const result = extractMessageContent({
      messageType: "audioMessage",
      message: { audioMessage: { seconds: 12 } },
    });
    expect(result).toEqual({ content: "[audio]", mediaType: "audio", durationSeconds: 12 });
  });

  it("omits durationSeconds when the audio message has no seconds field", () => {
    const result = extractMessageContent({
      messageType: "audioMessage",
      message: { audioMessage: {} },
    });
    expect(result.durationSeconds).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm exec vitest run src/routes/webhooks/evolution.test.ts`
Expected: FAIL — the first new test fails because today's `audioMessage` case always returns `{ content: "[audio]", mediaType: "audio" }` with no `durationSeconds` key, so `toEqual` doesn't match. The second test passes trivially (already `undefined`) — that's fine, it becomes a real regression guard once Step 3 changes the code.

- [ ] **Step 3: Extend the schema, type, and extraction function**

In `packages/shared/src/schemas/evolution.ts`, change line 23 from:

```ts
      audioMessage: z.object({}).optional(),
```

to:

```ts
      audioMessage: z.object({ seconds: z.number().optional() }).passthrough().optional(),
```

In `packages/shared/src/types/message.ts`, add `duration_seconds` to `MessageMetadata` (after `tool_calls`):

```ts
export interface MessageMetadata {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  tool_calls?: string[];
  duration_seconds?: number;
}
```

In `apps/api/src/routes/webhooks/evolution.ts`, change the `extractMessageContent` signature (line 18) and the `audioMessage` case (line 32-33):

```ts
export function extractMessageContent(
  data: Record<string, unknown>
): { content: string; mediaType: string | null; durationSeconds?: number } {
```

```ts
    case "audioMessage": {
      const audio = message.audioMessage as Record<string, unknown> | undefined;
      const seconds = typeof audio?.seconds === "number" ? audio.seconds : undefined;
      return { content: "[audio]", mediaType: "audio", durationSeconds: seconds };
    }
```

Then update the call site (around line 110) to capture the new field and pass it into the "contact" `saveMessage` call (around line 147-154). First, change:

```ts
      // Extract message content
      const { content, mediaType } = extractMessageContent(payload.data as Record<string, unknown>);
```

to:

```ts
      // Extract message content
      const { content, mediaType, durationSeconds } = extractMessageContent(payload.data as Record<string, unknown>);
```

Then change the "Save message (with idempotency)" block from:

```ts
      // Save message (with idempotency)
      const message = await saveMessage({
        conversationId: conversation.id,
        organizationId,
        evolutionMessageId,
        role: "contact",
        content,
        mediaType: mediaType as any,
      });
```

to:

```ts
      // Save message (with idempotency)
      const message = await saveMessage({
        conversationId: conversation.id,
        organizationId,
        evolutionMessageId,
        role: "contact",
        content,
        mediaType: mediaType as any,
        metadata: durationSeconds !== undefined ? { duration_seconds: durationSeconds } : undefined,
      });
```

(The `fromMe` branch's `saveMessage` call is left unchanged — a human replying with their own voice note directly from their phone never reaches `process-message`, since that branch returns early, so there's nothing there that would ever read `duration_seconds`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm exec vitest run src/routes/webhooks/evolution.test.ts`
Expected: PASS — all 7 tests (5 existing + 2 new).

Then run the full existing suite to confirm nothing else broke:

Run: `cd apps/api && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS, no type errors.

Also typecheck `apps/worker` and `apps/web`, since `MessageMetadata` is a shared type both depend on:

Run: `cd apps/worker && pnpm exec tsc --noEmit && cd ../web && pnpm exec tsc --noEmit`
Expected: no type errors in either.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas/evolution.ts packages/shared/src/types/message.ts apps/api/src/routes/webhooks/evolution.ts apps/api/src/routes/webhooks/evolution.test.ts
git commit -m "feat: capture voice note duration through the webhook"
```

---

### Task 2: Audio transcription module

**Files:**
- Create: `apps/worker/src/lib/audio-transcription.ts`
- Test: `apps/worker/src/lib/audio-transcription.test.ts`

**Interfaces:**
- Consumes: `resolveApiKey(organizationId: string, provider: LLMProvider): Promise<string>` from `apps/worker/src/lib/vault.ts` (already exists, already supports `"openai"` as a provider — verified in that file's `ENV_FALLBACKS` map). `process.env.EVOLUTION_API_URL` / `process.env.EVOLUTION_API_KEY` (already used the same way in `apps/worker/src/workers/send-message.ts`).
- Produces: `transcribeAudioMessage(params: { instanceName: string; evolutionMessageId: string; organizationId: string }): Promise<{ ok: true; text: string } | { ok: false; reason: string }>` — Task 3 calls this directly and branches on `.ok`. Also exports `pickAudioFileExtension(mimetype: string): string` (pure helper, tested here, not otherwise consumed outside this file).

The OpenAI key is resolved **inside** this function (not passed in already-resolved) specifically so a missing/blank key — the org hasn't configured one yet — is caught by the same try/catch as every other failure mode and turns into `{ ok: false, reason }` instead of throwing and crashing the job.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/lib/audio-transcription.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickAudioFileExtension } from "./audio-transcription.js";

describe("pickAudioFileExtension", () => {
  it("maps audio/mp4 to mp4", () => {
    expect(pickAudioFileExtension("audio/mp4")).toBe("mp4");
  });

  it("maps audio/mpeg and audio/mp3 to mp3", () => {
    expect(pickAudioFileExtension("audio/mpeg")).toBe("mp3");
    expect(pickAudioFileExtension("audio/mp3")).toBe("mp3");
  });

  it("maps audio/wav to wav", () => {
    expect(pickAudioFileExtension("audio/wav")).toBe("wav");
  });

  it("maps audio/webm to webm", () => {
    expect(pickAudioFileExtension("audio/webm")).toBe("webm");
  });

  it("falls back to mp4 for an unrecognized mimetype (e.g. raw WhatsApp ogg/opus)", () => {
    expect(pickAudioFileExtension("audio/ogg; codecs=opus")).toBe("mp4");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm exec vitest run src/lib/audio-transcription.test.ts`
Expected: FAIL with "Failed to resolve import ./audio-transcription.js" (file doesn't exist yet).

- [ ] **Step 3: Create the module**

Create `apps/worker/src/lib/audio-transcription.ts`:

```ts
import { resolveApiKey } from "./vault.js";

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

interface EvolutionMediaResponse {
  base64: string;
  mimetype: string;
}

async function fetchAudioAsMp4(instanceName: string, evolutionMessageId: string): Promise<EvolutionMediaResponse> {
  const response = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      message: { key: { id: evolutionMessageId } },
      convertToMp4: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Evolution media fetch error ${response.status}`);
  }

  const data = await response.json();
  return { base64: data.base64, mimetype: data.mimetype };
}

// Whisper picks its decoder from the file extension in the multipart
// upload, not the mimetype header. Evolution's convertToMp4 always
// returns "audio/mp4" in practice, but this stays defensive for any other
// mimetype it might someday return instead of assuming.
export function pickAudioFileExtension(mimetype: string): string {
  if (mimetype.includes("mp4")) return "mp4";
  if (mimetype.includes("mpeg") || mimetype.includes("mp3")) return "mp3";
  if (mimetype.includes("wav")) return "wav";
  if (mimetype.includes("webm")) return "webm";
  return "mp4";
}

async function transcribeWithWhisper(base64Audio: string, mimetype: string, apiKey: string): Promise<string> {
  const buffer = Buffer.from(base64Audio, "base64");
  const extension = pickAudioFileExtension(mimetype);

  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimetype }), `audio.${extension}`);
  formData.append("model", "whisper-1");
  formData.append("language", "pt");

  const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI transcription error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return typeof data.text === "string" ? data.text : "";
}

export type TranscriptionResult = { ok: true; text: string } | { ok: false; reason: string };

export async function transcribeAudioMessage(params: {
  instanceName: string;
  evolutionMessageId: string;
  organizationId: string;
}): Promise<TranscriptionResult> {
  try {
    const apiKey = await resolveApiKey(params.organizationId, "openai");
    const { base64, mimetype } = await fetchAudioAsMp4(params.instanceName, params.evolutionMessageId);
    const text = await transcribeWithWhisper(base64, mimetype, apiKey);

    if (!text.trim()) {
      return { ok: false, reason: "empty_transcription" };
    }

    return { ok: true, text: text.trim() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && pnpm exec vitest run src/lib/audio-transcription.test.ts`
Expected: PASS (5 tests).

Then typecheck:

Run: `cd apps/worker && pnpm exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/audio-transcription.ts apps/worker/src/lib/audio-transcription.test.ts
git commit -m "feat: add audio transcription module (Evolution fetch + Whisper)"
```

---

### Task 3: Wire transcription into process-message

**Files:**
- Modify: `packages/database/src/queries/messages.ts`
- Modify: `apps/worker/src/workers/process-message.ts`
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`

**Interfaces:**
- Consumes: `transcribeAudioMessage` and `TranscriptionResult` from Task 2 (`../lib/audio-transcription.js`). `Message.metadata?.duration_seconds` from Task 1.
- Produces: `updateMessageContent(client: SupabaseClient, id: string, content: string): Promise<void>` — a new DB query, exported from `@aula-agente/database` via the existing `export * from "./messages.js"` in `packages/database/src/queries/index.ts` (no change needed there).

**Note:** `updateMessageContent` fires a Postgres `UPDATE` event, not an `INSERT` — the dashboard's `useRealtime<Message>` call in `chat-panel.tsx` currently only wires an `onInsert` callback (confirmed by reading the file), so without this task's chat-panel.tsx change, an open conversation would keep showing `[audio]` until the page is refreshed, even though the row is already updated. The `useRealtime` hook itself already supports `onUpdate` (confirmed by reading `apps/web/src/lib/realtime.ts` — the subscription's default `event: "*"` already covers UPDATE, only the callback was never passed) — this is a wiring gap, not a new capability to build.

This task's own correctness (the BullMQ job branching, the live Evolution/OpenAI calls) is verified manually against the real running services, not with a unit test — matching this file's existing precedent (it has no test file today) and the same precedent already established for `send-message.ts`'s Evolution-calling branches.

- [ ] **Step 1: Add the DB query**

In `packages/database/src/queries/messages.ts`, add this function after `createMessage` (no test — matches every other function in this file, none of which have one):

```ts
export async function updateMessageContent(client: SupabaseClient, id: string, content: string) {
  const { error } = await client.from("messages").update({ content }).eq("id", id);
  if (error) throw error;
}
```

Run: `cd packages/database && pnpm exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 2: Wire the transcription step into process-message.ts**

Replace the full contents of `apps/worker/src/workers/process-message.ts` with:

```ts
import { Worker } from "bullmq";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { ProcessMessageJobData } from "@aula-agente/queue";
import { getRedisConnection, getSendMessageQueue } from "@aula-agente/queue";
import { getAdminClient, getAgentById, getRecentMessages, getConversationById } from "@aula-agente/database";
import { createMessage, updateConversation, updateMessageContent } from "@aula-agente/database";
import { getInstanceById } from "@aula-agente/database";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";
import { resolveApiKey } from "../lib/vault.js";
import { runAgent } from "../agents/agent-runner.js";
import { transcribeAudioMessage } from "../lib/audio-transcription.js";

const AUDIO_DURATION_CAP_SECONDS = 300;
const AUDIO_FALLBACK_TEXT =
  "Desculpa, não consegui entender esse áudio 🙏 Pode escrever a mensagem, por favor?";

async function sendFallbackText(
  db: SupabaseClient,
  text: string,
  params: { conversationId: string; organizationId: string; instanceId: string; phone: string }
) {
  const responseMessage = await createMessage(db, {
    conversation_id: params.conversationId,
    organization_id: params.organizationId,
    evolution_message_id: null,
    role: "agent",
    content: text,
    media_url: null,
    media_type: null,
    metadata: null,
  });

  const sendQueue = getSendMessageQueue();
  await sendQueue.add("send-message", {
    conversationId: params.conversationId,
    messageId: responseMessage.id,
    instanceId: params.instanceId,
    phone: params.phone,
    content: text,
    organizationId: params.organizationId,
  });
}

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

        // Load instance now — needed both by agent tools (to send a photo
        // mid-turn) and further down to send the text reply.
        const instance = await getInstanceById(db, conversation.evolution_instance_id);
        const phone = conversation.wa_contacts?.phone || "";

        // Resolve API key for this tenant
        const apiKey = await resolveApiKey(organizationId, agent.provider);

        // Load recent message history
        const recentMessages = await getRecentMessages(db, conversationId, 20);

        // Find the current message
        const currentMessage = recentMessages.find((m) => m.id === messageId);
        if (!currentMessage) {
          throw new Error(`Message ${messageId} not found`);
        }

        // Unsupported WhatsApp message types (reactions, protocol messages, etc.)
        // are saved with empty content — the LLM can't process those, skip them.
        if (!currentMessage.content.trim()) {
          console.log(`Message ${messageId} has empty content, skipping`);
          return;
        }

        // Voice notes arrive with a "[audio]" placeholder — transcribe it to
        // real text before the agent ever sees it. This runs here (not in
        // the webhook) so the webhook keeps acking Evolution fast regardless
        // of transcription latency. Any failure (missing key, fetch error,
        // transcription error, empty transcript, or too-long audio) sends a
        // fixed "please type instead" reply and skips the LLM entirely.
        let effectiveMessage = currentMessage;

        if (currentMessage.media_type === "audio") {
          const durationSeconds = currentMessage.metadata?.duration_seconds;

          if (typeof durationSeconds === "number" && durationSeconds > AUDIO_DURATION_CAP_SECONDS) {
            console.log(`Message ${messageId} audio exceeds ${AUDIO_DURATION_CAP_SECONDS}s cap, skipping transcription`);
            await sendFallbackText(db, AUDIO_FALLBACK_TEXT, {
              conversationId,
              organizationId,
              instanceId: instance.id,
              phone,
            });
            return;
          }

          const transcription = await transcribeAudioMessage({
            instanceName: instance.instance_name,
            evolutionMessageId: currentMessage.evolution_message_id!,
            organizationId,
          });

          if (!transcription.ok) {
            console.log(`Message ${messageId} transcription failed: ${transcription.reason}`);
            await sendFallbackText(db, AUDIO_FALLBACK_TEXT, {
              conversationId,
              organizationId,
              instanceId: instance.id,
              phone,
            });
            return;
          }

          const transcribedContent = `🎤 ${transcription.text}`;
          await updateMessageContent(db, currentMessage.id, transcribedContent);
          effectiveMessage = { ...currentMessage, content: transcribedContent };
        }

        // Remove current message from history
        const history = recentMessages.filter((m) => m.id !== messageId);

        // Run the agent
        const result = await runAgent({
          agent,
          messages: history,
          currentMessage: effectiveMessage,
          apiKey,
          organizationId,
          conversationId,
          instanceId: instance.id,
          phone,
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
            phone,
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

- [ ] **Step 3: Wire the dashboard to react to message updates, not just inserts**

In `apps/web/src/components/inbox/chat-panel.tsx`, change the `useRealtime<Message>` call (currently only has `onInsert`):

```tsx
  // Realtime messages
  useRealtime<Message>({
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`,
    onInsert: (newMsg) => {
      setMessages((prev) => [...prev, newMsg]);
    },
  });
```

to:

```tsx
  // Realtime messages
  useRealtime<Message>({
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`,
    onInsert: (newMsg) => {
      setMessages((prev) => [...prev, newMsg]);
    },
    onUpdate: (updatedMsg) => {
      setMessages((prev) => prev.map((m) => (m.id === updatedMsg.id ? updatedMsg : m)));
    },
  });
```

Without this, `updateMessageContent` still updates the row correctly, but an already-open conversation keeps showing `[audio]` until the page is reloaded.

- [ ] **Step 4: Typecheck and run the full worker and web test suites**

Run: `cd apps/worker && pnpm exec tsc --noEmit`
Expected: no type errors.

Run: `cd apps/worker && pnpm exec vitest run`
Expected: PASS — all existing tests (`agent-runner.test.ts`, `search-catalog.test.ts`, `audio-transcription.test.ts`) plus this task's change, which has no test of its own (I/O-heavy BullMQ handler, matches this file's existing untested precedent).

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/queries/messages.ts apps/worker/src/workers/process-message.ts apps/web/src/components/inbox/chat-panel.tsx
git commit -m "feat: transcribe voice notes before the agent responds"
```

- [ ] **Step 6: Deploy and verify live**

This task changes `apps/worker` (the new transcription step) and `apps/web` (the realtime update wiring), and depends on Task 1's `apps/api` change (duration capture) already being deployed — redeploy all three services (`api`, `worker`, and the web app, however it's deployed/rebuilt in this project).

Then verify two ways:

1. **Duration-cap and failure paths** (can be simulated without a real voice note): POST a synthetic webhook to `/webhooks/evolution` for the safe test number with `messageType: "audioMessage"` and a `message.audioMessage.seconds` value over 300 — confirm the conversation receives the exact fallback text and no LLM call happens (check worker logs for `"audio exceeds 300s cap"` and confirm no `"Processed message ... -> response ..."` log line for that message).
2. **Real transcription** (cannot be simulated — `getBase64FromMediaMessage` looks up a real message in Evolution's own store by id, so it needs an actual voice note Evolution actually received): send a real WhatsApp voice note to the safe test number's connected instance, then check the conversation's messages for the `🎤 <transcript>`-prefixed content and confirm the agent's reply is coherent with what was said.

---

## Post-plan note (not a task)

Before this feature does anything in production, `OPENAI_API_KEY` must be filled in on the `worker` service's environment in EasyPanel (it currently exists as an empty value). Until then, every voice note will correctly fall back to "please type instead" rather than crash — but transcription won't actually happen.
