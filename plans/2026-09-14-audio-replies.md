# Respostas em Áudio da Helena — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Helena reply with a WhatsApp voice note (generated via OpenAI TTS) when the customer's own message was audio, gated by a per-agent on/off toggle, with an automatic fallback to text whenever the reply contains a link, a multi-item list, or the audio generation itself fails.

**Architecture:** A new pure helper (`apps/worker/src/lib/audio-generation.ts`) decides whether a given response text is "simple enough" for audio and calls OpenAI's TTS endpoint to get base64 audio. `process-message.ts` (the worker that generates the AI's reply) calls this helper right after generating the text response and, on success, attaches the base64 audio to the `send-message` job instead of nothing. `send-message.ts` (the worker that actually talks to Evolution) gains a third send path — `sendEvolutionAudio` — alongside its existing text and image paths, using Evolution's `POST /message/sendWhatsAppAudio/:instance` endpoint. A new `tools_config.audio_replies` boolean (default `false`) and `tools_config.audio_voice` string (default `"alloy"`) gate and configure the feature, editable from the existing "Ferramentas" tab of the agent config screen.

**Tech Stack:** TypeScript, Zod, BullMQ, OpenAI `/v1/audio/speech` REST endpoint, Evolution API `sendWhatsAppAudio` REST endpoint, Next.js/React (shadcn `Switch`/`Select`) for the toggle UI.

**Spec:** `specs/2026-09-14-audio-replies-design.md`

## Global Constraints

- Reuse the existing `resolveApiKey(organizationId, "openai")` pattern (already used by `audio-transcription.ts`) — no new secret-storage mechanism.
- No new media storage: the generated audio never gets a URL or gets persisted anywhere — it travels as base64 from generation straight through the BullMQ job to the Evolution API call, then is discarded.
- Never let a TTS failure block the customer from getting a reply — every failure path falls back to the existing text-send flow.
- Match this codebase's existing test convention for `apps/worker`: pure logic in `lib/*.ts` gets unit tests; the BullMQ `workers/*.ts` wiring files stay untested glue code (this repo has zero existing tests for any file under `apps/worker/src/workers/`).
- The `audio_replies`/`audio_voice` toggle only appears in the post-creation "Ferramentas" config screen (`ferramentas-section.tsx`), not in the agent-creation form (`agent-form.tsx`) — this matches how `followup_automatico` was rolled out; do not touch `agent-form.tsx`.

---

### Task 1: Add `audio_replies` and `audio_voice` to the shared tools config schema and type

**Files:**
- Modify: `packages/shared/src/schemas/agent.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Test: `packages/shared/src/schemas/agent.test.ts`

**Interfaces:**
- Produces: `toolsConfigSchema` (Zod) now parses/defaults two new keys: `audio_replies: boolean` (default `false`), `audio_voice: string` (default `"alloy"`). The `ToolsConfig` TypeScript interface gains matching fields `audio_replies: boolean; audio_voice: string;`. Every later task that reads `agent.tools_config.audio_replies` / `.audio_voice` relies on this.

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe("toolsConfigSchema", ...)` block in `packages/shared/src/schemas/agent.test.ts` (right after the existing `it("fills in followup_automatico...")` test, still inside the same `describe`):

```typescript
  it("defaults audio_replies to false and audio_voice to alloy when absent", () => {
    const result = toolsConfigSchema.parse({
      search_knowledge: true,
      search_faq: true,
      send_catalog_photo: false,
      create_task: false,
    });
    expect(result.audio_replies).toBe(false);
    expect(result.audio_voice).toBe("alloy");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies/packages/shared" && pnpm vitest run src/schemas/agent.test.ts`
Expected: FAIL — `result.audio_replies` is `undefined`, not `false` (the schema doesn't have this key yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/schemas/agent.ts`, change the `toolsConfigSchema` definition (lines 10-21) from:

```typescript
export const toolsConfigSchema = z.object({
  search_knowledge: z.boolean().default(true),
  search_faq: z.boolean().default(true),
  send_catalog_photo: z.boolean().default(false),
  create_task: z.boolean().default(false),
  update_qualification: z.boolean().default(false),
  // Reuses the same literal as followupAutomaticoConfigSchema's own
  // per-field defaults above (both sourced from DEFAULT_FOLLOWUP_AUTOMATICO)
  // so a future change to the windows can't update one and silently miss
  // the other.
  followup_automatico: followupAutomaticoConfigSchema.default(DEFAULT_FOLLOWUP_AUTOMATICO),
});
```

to:

```typescript
export const toolsConfigSchema = z.object({
  search_knowledge: z.boolean().default(true),
  search_faq: z.boolean().default(true),
  send_catalog_photo: z.boolean().default(false),
  create_task: z.boolean().default(false),
  update_qualification: z.boolean().default(false),
  // Reuses the same literal as followupAutomaticoConfigSchema's own
  // per-field defaults above (both sourced from DEFAULT_FOLLOWUP_AUTOMATICO)
  // so a future change to the windows can't update one and silently miss
  // the other.
  followup_automatico: followupAutomaticoConfigSchema.default(DEFAULT_FOLLOWUP_AUTOMATICO),
  audio_replies: z.boolean().default(false),
  audio_voice: z.string().default("alloy"),
});
```

Then in `packages/shared/src/types/agent.ts`, change the `ToolsConfig` interface from:

```typescript
export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
  create_task: boolean;
  update_qualification: boolean;
  // Optional: rows written before this feature shipped don't have this key.
  // Every reader must fall back to DEFAULT_FOLLOWUP_AUTOMATICO.
  followup_automatico?: FollowupAutomaticoConfig;
}
```

to:

```typescript
export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
  create_task: boolean;
  update_qualification: boolean;
  // Optional: rows written before this feature shipped don't have this key.
  // Every reader must fall back to DEFAULT_FOLLOWUP_AUTOMATICO.
  followup_automatico?: FollowupAutomaticoConfig;
  audio_replies: boolean;
  audio_voice: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies/packages/shared" && pnpm vitest run src/schemas/agent.test.ts`
Expected: PASS (all tests in the file, including the new one).

Then also run the full package typecheck to make sure the interface change doesn't break any exhaustive object literal elsewhere: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies" && pnpm turbo typecheck --filter=@aula-agente/shared --filter=@aula-agente/api --filter=@aula-agente/worker --filter=@aula-agente/agent-runtime`
Expected: all pass. (If `apps/web` fails to typecheck because of a now-incomplete `ToolsConfig` literal, that is expected and will be fixed in Task 6 — `apps/web` isn't in this typecheck filter for that reason.)

- [ ] **Step 5: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies"
git add packages/shared/src/schemas/agent.ts packages/shared/src/types/agent.ts packages/shared/src/schemas/agent.test.ts
git commit -m "feat(shared): add audio_replies and audio_voice to tools config"
```

---

### Task 2: `audio-generation.ts` — complexity heuristic + OpenAI TTS call

**Files:**
- Create: `apps/worker/src/lib/audio-generation.ts`
- Create: `apps/worker/src/lib/audio-generation.test.ts`

**Interfaces:**
- Consumes: `resolveApiKey(organizationId: string, provider: "openai"): Promise<string>` from `@aula-agente/agent-runtime` (already used the same way in `apps/worker/src/lib/audio-transcription.ts`).
- Produces: `isSimpleEnoughForAudio(text: string): boolean` and `generateSpeech(params: { text: string; voice: string; organizationId: string }): Promise<SpeechResult>` where `type SpeechResult = { ok: true; audioBase64: string } | { ok: false; reason: string }`. Task 5 (`process-message.ts`) calls both.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/lib/audio-generation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isSimpleEnoughForAudio } from "./audio-generation.js";

describe("isSimpleEnoughForAudio", () => {
  it("accepts a short conversational reply", () => {
    expect(isSimpleEnoughForAudio("Oi! Vi que você se interessou pela Titan 160, qual seu CPF?")).toBe(true);
  });

  it("rejects a reply containing a link", () => {
    expect(isSimpleEnoughForAudio("Segue o link da simulação: https://link.icred.app/5gxJpdy")).toBe(false);
  });

  it("rejects a reply with a bulleted list of 2+ options", () => {
    const text = "As mais baratas hoje são:\n\n🔹 Avelloz AZ1 50cc – R$ 13.900\n🔹 Factor 150 ED – R$ 22.904";
    expect(isSimpleEnoughForAudio(text)).toBe(false);
  });

  it("rejects a reply with a numbered list of 2+ options", () => {
    const text = "Temos duas opções:\n1) Bros 160 azul\n2) Bros 160 preta";
    expect(isSimpleEnoughForAudio(text)).toBe(false);
  });

  it("accepts a reply with only a single list-like line", () => {
    const text = "Beleza! 🔹 Vou confirmar e te aviso.";
    expect(isSimpleEnoughForAudio(text)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies/apps/worker" && pnpm vitest run src/lib/audio-generation.test.ts`
Expected: FAIL — the module `./audio-generation.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `apps/worker/src/lib/audio-generation.ts`:

```typescript
import { resolveApiKey } from "@aula-agente/agent-runtime";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

// A link read aloud is useless (the customer can't tap it), and a list of
// 2+ options/prices is hard to follow by ear — both fall back to text even
// when the audio-replies toggle and the "customer sent audio" gate are
// satisfied.
const LIST_LINE_PATTERN = /^\s*(🔹|-|•|\d+[.)])/;

export function isSimpleEnoughForAudio(text: string): boolean {
  if (/https?:\/\//i.test(text)) return false;
  const listLineCount = text.split("\n").filter((line) => LIST_LINE_PATTERN.test(line)).length;
  return listLineCount < 2;
}

async function requestSpeech(text: string, voice: string, apiKey: string): Promise<string> {
  const response = await fetch(OPENAI_SPEECH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: "tts-1", voice, input: text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI speech error ${response.status}: ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}

export type SpeechResult = { ok: true; audioBase64: string } | { ok: false; reason: string };

export async function generateSpeech(params: {
  text: string;
  voice: string;
  organizationId: string;
}): Promise<SpeechResult> {
  try {
    const apiKey = await resolveApiKey(params.organizationId, "openai");
    const audioBase64 = await requestSpeech(params.text, params.voice, apiKey);
    return { ok: true, audioBase64 };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies/apps/worker" && pnpm vitest run src/lib/audio-generation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies"
git add apps/worker/src/lib/audio-generation.ts apps/worker/src/lib/audio-generation.test.ts
git commit -m "feat(worker): add OpenAI TTS generation and audio-simplicity heuristic"
```

---

### Task 3: Add `audioBase64` to the send-message job payload type

**Files:**
- Modify: `packages/queue/src/types.ts`

**Interfaces:**
- Produces: `SendMessageJobData.audioBase64?: string`. Task 4 reads this field to pick the send path; Task 5 sets it.

- [ ] **Step 1: Write the failing test**

There's no existing test file for `packages/queue/src/types.ts` (it's a pure interface, nothing to unit-test) — skip the test-first step here and go straight to the typecheck-driven step below, which plays the same role a failing test would: Task 4 and Task 5 will reference `job.data.audioBase64` / `{ ..., audioBase64 }`, which won't typecheck until this field exists. Confirm that now:

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies" && grep -n "audioBase64" packages/queue/src/types.ts`
Expected: no output (field doesn't exist yet).

- [ ] **Step 2: (equivalent of "run test to verify it fails") — confirmed above by the empty grep.**

- [ ] **Step 3: Write minimal implementation**

In `packages/queue/src/types.ts`, change the `SendMessageJobData` interface from:

```typescript
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

to:

```typescript
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
  audioBase64?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies" && grep -n "audioBase64" packages/queue/src/types.ts`
Expected: prints the new line — field exists.

- [ ] **Step 5: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies"
git add packages/queue/src/types.ts
git commit -m "feat(queue): add optional audioBase64 to send-message job data"
```

---

### Task 4: `send-message.ts` — send audio via Evolution's `sendWhatsAppAudio`

**Files:**
- Modify: `apps/worker/src/workers/send-message.ts`

**Interfaces:**
- Consumes: `SendMessageJobData` (from Task 3, now including `audioBase64?: string`).
- Produces: no new exports (this file's functions are all internal to the worker) — but from here on, a job with `audioBase64` set results in a WhatsApp voice note instead of a text message.

**No test step** — this file has zero existing tests (matches the "worker wiring stays untested" constraint noted at the top of this plan); verify by manual reasoning and by the full worker typecheck in Step 2 below.

- [ ] **Step 1: Write the implementation**

In `apps/worker/src/workers/send-message.ts`, add a new function right after `sendEvolutionMedia` (i.e. after its closing `}` and before `export function startSendMessageWorker()`):

```typescript
async function sendEvolutionAudio(instanceName: string, phone: string, audioBase64: string) {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendWhatsAppAudio/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: phone, audio: audioBase64, encoding: true }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API audio send error ${response.status}: ${body}`);
  }

  return response.json();
}
```

Then change the worker body from:

```typescript
      const { instanceId, phone, content, mediaUrl, caption } = job.data;

      const db = getAdminClient();
      const instance = await getInstanceById(db, instanceId);

      if (mediaUrl) {
        await sendEvolutionMedia(instance.instance_name, phone, mediaUrl, caption || content);
      } else {
        await sendEvolutionText(instance.instance_name, phone, content);
      }
```

to:

```typescript
      const { instanceId, phone, content, mediaUrl, audioBase64, caption } = job.data;

      const db = getAdminClient();
      const instance = await getInstanceById(db, instanceId);

      if (audioBase64) {
        await sendEvolutionAudio(instance.instance_name, phone, audioBase64);
      } else if (mediaUrl) {
        await sendEvolutionMedia(instance.instance_name, phone, mediaUrl, caption || content);
      } else {
        await sendEvolutionText(instance.instance_name, phone, content);
      }
```

- [ ] **Step 2: Verify with typecheck (stands in for a passing test)**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies" && pnpm turbo typecheck --filter=@aula-agente/worker`
Expected: passes with no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies"
git add apps/worker/src/workers/send-message.ts
git commit -m "feat(worker): send WhatsApp voice notes via Evolution's sendWhatsAppAudio"
```

---

### Task 5: `process-message.ts` — decide audio vs. text and generate the reply

**Files:**
- Modify: `apps/worker/src/workers/process-message.ts`

**Interfaces:**
- Consumes: `isSimpleEnoughForAudio(text: string): boolean` and `generateSpeech(params): Promise<SpeechResult>` from `../lib/audio-generation.js` (Task 2). `agent.tools_config.audio_replies: boolean` and `agent.tools_config.audio_voice: string` (Task 1). `SendMessageJobData.audioBase64?: string` (Task 3).
- Produces: no new exports — but from here on, a reply to a customer's audio message becomes a WhatsApp voice note whenever the agent's `audio_replies` toggle is on and the reply text is simple enough.

**No test step** — same reasoning as Task 4 (untested worker-wiring file); this task's own testable logic (`isSimpleEnoughForAudio`, `generateSpeech`) was already covered in Task 2. Verify by typecheck.

- [ ] **Step 1: Write the implementation**

In `apps/worker/src/workers/process-message.ts`, add the import (alongside the existing `describeImageMessage` import):

```typescript
import { generateSpeech, isSimpleEnoughForAudio } from "../lib/audio-generation.js";
```

Then change the block that saves and sends the agent's text reply — currently:

```typescript
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
              cache_read_tokens: result.cacheReadTokens,
              cache_write_tokens: result.cacheWriteTokens,
              cache_status: result.cacheStatus,
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
```

to:

```typescript
        if (result.text.trim()) {
          // Mirror the customer's own modality: only even attempt audio when
          // they sent audio, the agent has the toggle on, and the reply text
          // itself is simple enough to be understood by ear (no link, no
          // multi-item list). Any failure — toggle off, complex text, or the
          // TTS call itself failing — falls through to the plain text send
          // below exactly like it always has.
          let audioBase64: string | undefined;
          if (
            agent.tools_config.audio_replies &&
            currentMessage.media_type === "audio" &&
            isSimpleEnoughForAudio(result.text)
          ) {
            const speech = await generateSpeech({
              text: result.text,
              voice: agent.tools_config.audio_voice,
              organizationId,
            });
            if (speech.ok) {
              audioBase64 = speech.audioBase64;
            } else {
              console.log(`Message ${messageId} audio generation failed, falling back to text: ${speech.reason}`);
            }
          }

          const responseMessage = await createMessage(db, {
            conversation_id: conversationId,
            organization_id: organizationId,
            evolution_message_id: null,
            role: "agent",
            content: result.text,
            media_url: null,
            media_type: audioBase64 ? "audio" : null,
            metadata: {
              model: result.model,
              input_tokens: result.inputTokens,
              output_tokens: result.outputTokens,
              cache_read_tokens: result.cacheReadTokens,
              cache_write_tokens: result.cacheWriteTokens,
              cache_status: result.cacheStatus,
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
            ...(audioBase64 ? { audioBase64 } : {}),
          });

          console.log(`Processed message ${messageId} -> response ${responseMessage.id}`);
        } else {
          console.log(`Processed message ${messageId} -> no text reply (tool-only response)`);
        }
```

- [ ] **Step 2: Verify with typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies" && pnpm turbo typecheck --filter=@aula-agente/worker`
Expected: passes with no errors.

- [ ] **Step 3: Run the full worker test suite as a regression check**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies" && pnpm turbo test --filter=@aula-agente/worker`
Expected: all existing tests still pass (this task doesn't add new ones, per the constraint above, but must not break `audio-transcription.test.ts`, `image-description.test.ts`, `followup-nudge.test.ts`, or the new `audio-generation.test.ts` from Task 2).

- [ ] **Step 4: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies"
git add apps/worker/src/workers/process-message.ts
git commit -m "feat(worker): generate and send audio replies when the customer sent audio"
```

---

### Task 6: "Ferramentas" screen — audio-replies toggle and voice picker

**Files:**
- Modify: `apps/web/src/components/agents/config/ferramentas-section.tsx`

**Interfaces:**
- Consumes: `ToolsConfig.audio_replies: boolean`, `ToolsConfig.audio_voice: string` (Task 1). Existing `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue` from `@/components/ui/select` (already used elsewhere in this app, e.g. `apps/web/src/components/inbox/assign-select.tsx`).
- Produces: no new exports — this is a leaf UI component. No test step (this codebase has no test files under `apps/web/src/components/agents/config/`, matching the "follow established patterns" constraint — this directory's components are exercised manually/E2E, not unit tested).

- [ ] **Step 1: Write the implementation**

In `apps/web/src/components/agents/config/ferramentas-section.tsx`, add the `Select` import to the existing import line:

```typescript
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
```

Add a voice-options constant right after the `TOOL_ROWS` array (after its closing `];`):

```typescript
// Named voices exposed by OpenAI's text-to-speech API at the time this was
// built. If OpenAI renames or retires one, update this list — the schema
// field itself (`audio_voice`) is a plain string, so no code change is
// needed anywhere else.
const AUDIO_VOICE_OPTIONS = [
  { value: "alloy", label: "Alloy" },
  { value: "echo", label: "Echo" },
  { value: "fable", label: "Fable" },
  { value: "onyx", label: "Onyx" },
  { value: "nova", label: "Nova" },
  { value: "shimmer", label: "Shimmer" },
];
```

Then add a new `Card` at the end of the component's returned JSX — right after the closing `</Card>` of the "Followup automático" card and before the final `</div>`:

```tsx
      <Card>
        <CardHeader>
          <CardTitle>Resposta em áudio</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Responder com áudio</p>
              <p className="text-sm text-muted-foreground">
                Quando o cliente manda áudio, a Helena responde com uma nota de voz em vez
                de texto (a menos que a resposta tenha link ou lista de opções, caso em que
                ela sempre usa texto).
              </p>
            </div>
            <Switch
              checked={toolsConfig.audio_replies ?? false}
              onCheckedChange={(v) => {
                const next = { ...toolsConfig, audio_replies: v };
                setToolsConfig(next);
                onPatch({ tools_config: next });
              }}
            />
          </div>

          {toolsConfig.audio_replies && (
            <div className="space-y-2">
              <Label>Voz</Label>
              <Select
                value={toolsConfig.audio_voice ?? "alloy"}
                onValueChange={(v) => {
                  const next = { ...toolsConfig, audio_voice: v };
                  setToolsConfig(next);
                  onPatch({ tools_config: next });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUDIO_VOICE_OPTIONS.map((voice) => (
                    <SelectItem key={voice.value} value={voice.value}>
                      {voice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>
```

- [ ] **Step 2: Verify with typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies" && pnpm turbo typecheck --filter=@aula-agente/web`
Expected: passes with no errors.

- [ ] **Step 3: Manually verify in the browser**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies/apps/web" && pnpm dev`

Open the agent config screen, go to the "Ferramentas" tab, confirm:
- A new "Resposta em áudio" card appears at the bottom with a toggle, off by default.
- Turning it on reveals the voice select, defaulted to "Alloy".
- Toggling it and picking a voice both persist (reload the page, confirm the choice stuck).

**Note:** per this project's own memory/CLAUDE.md context, `pnpm dev` on `apps/web` talks to the **live production API**, so this check edits real Helena agent config data — turn the toggle back off (or leave it configured deliberately) when done, and mention this to the user before/after.

- [ ] **Step 4: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies"
git add apps/web/src/components/agents/config/ferramentas-section.tsx
git commit -m "feat(web): add audio-replies toggle and voice picker to Ferramentas tab"
```

---

### Task 7: Deploy and end-to-end verification

**Files:** none (operational task)

- [ ] **Step 1: Push to trigger deploy**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/audio-replies"
git push origin worktree-audio-replies
```

Note: this task must be run from the ORIGINAL checkout on `main` after this branch is merged — the worktree branch itself does not deploy. See "Finish" section of the subagent-driven-development skill: merge to main first, then push main, then perform this task's verification steps against production.

- [ ] **Step 2: Confirm the worker deployed the new code**

There's no safe unauthenticated HTTP endpoint to probe this change directly (unlike the wix-lead webhook earlier in this session) — `process-message.ts` and `send-message.ts` only run against real queued jobs. Confirm via EasyPanel's deployment history/logs for the `worker` service instead: the latest deploy's timestamp should be after the push, and its log should show `"Process-message worker started"` / `"Send-message worker started"` with no startup errors.

- [ ] **Step 3: End-to-end test using a real conversation, with the user's explicit go-ahead first**

This sends a real OpenAI TTS request and a real WhatsApp voice note — get the user's confirmation before running it, same as every other live test in this session. Suggested script (turn `audio_replies` on for the test, using the user's own number as the contact so no real customer is touched):

1. Turn on `audio_replies` for the agent via the dashboard (Task 6's UI).
2. Send a voice note from the user's own WhatsApp number to the connected business number, asking something short and conversational (no request for prices/links).
3. Confirm Helena's reply arrives as a playable WhatsApp voice note, not text.
4. Send a second voice note asking for something that would trigger a link or a list (e.g. "manda o link pra eu simular") and confirm that reply comes back as **text**, not audio (the complexity fallback).
5. Turn `audio_replies` back off (or leave on, per the user's preference) once confirmed.

- [ ] **Step 4: Report results to the user**

Summarize what was tested and its outcome — no code changes in this step.
