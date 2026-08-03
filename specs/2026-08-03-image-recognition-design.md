# Image Recognition for the WhatsApp Agent — Design

## Goal

When a customer sends a WhatsApp photo, describe what's in it and let the
agent respond to it like any other message, instead of only seeing the
`[imagem]` placeholder (or the caption alone) it gets today. Two confirmed
use cases drive this: general "understand the photo like a person would"
requests, and customers sending a photo of their own motorcycle (trade-in /
appraisal context) — the description should call out brand/model/color/
visible condition when the photo is of a motorcycle.

## Non-goals

- No keeping the image "alive" in conversation history for later follow-up
  questions about the same photo ("what about that scratch there?") —
  confirmed with the user this is rare. A one-time text description is
  enough, same trade-off the audio-transcription feature already made for
  voice notes.
- No OCR-focused handling for documents/receipts/IDs — not the target use
  case for this pass.
- No displaying the raw image in the dashboard Inbox — only the generated
  text description is kept, same precedent as audio (no playback UI, no
  raw-file storage).
- No per-agent/organization opt-in toggle — runs automatically for every
  incoming image, unconditionally, same reasoning as audio transcription
  (it's a pipeline step, not a tool the model chooses to call).
- No new provider/model to manage: reuses whichever provider/model the
  organization already has configured for chat (see Architecture). No
  separate "vision-only" API key or fixed provider choice.
- Stickers (`stickerMessage`) stay out of scope — already a distinct
  message type in the schema, untouched by this change.

## Confirmed external contracts

**Fetching the image from Evolution API** — same endpoint audio already
uses: `POST {EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/{instanceName}`,
header `apikey: {EVOLUTION_API_KEY}`, JSON body `{ "message": { "key": { "id":
"<evolutionMessageId>" } } }` (the `convertToMp4` flag is audio/video-only —
omitted for images). Evolution looks the message up server-side by `key.id`
alone (confirmed against Evolution's own source for the audio feature — same
endpoint, same lookup). Response shape (confirmed for audio, assumed
identical shape for images since it's the same endpoint): `{ mediaType,
fileName, caption, size: {...}, mimetype, base64 }`. The exact `mimetype`
value for a WhatsApp photo (typically `image/jpeg`) and the precise shape of
`size` will be confirmed against a real test image during implementation,
the same way the audio feature was verified live rather than assumed.

**Describing the image** — the `ai` package (v7.0.18, already a dependency)
exports `ImagePart`/`UserContent` types supporting multimodal messages:
`generateText({ model, messages: [{ role: "user", content: [{ type: "text",
text: prompt }, { type: "image", image: <base64 string> }] }] })`. This is
provider-agnostic in `@ai-sdk/openai`, `@ai-sdk/anthropic`, and
`@ai-sdk/google` — all three already used by this codebase — so no new SDK
dependency is needed.

**Reusing the org's configured model** — `createModel(provider, modelName,
apiKey)`, already exported from `@aula-agente/agent-runtime` and already
used by `agent-runner.ts`, returns a `LanguageModel` usable directly with
`generateText`. `process-message.ts` already resolves `agent.provider`,
`agent.model`, and `apiKey` (via `resolveApiKey(organizationId,
agent.provider)`) earlier in the function, before the audio/image branch —
so describing an image needs zero additional key resolution or provider
selection.

## Architecture

**Where it runs** — inside `process-message.ts` (`apps/worker`), in the same
place as the audio branch: after the message and `agent`/`apiKey` are
loaded, before `runAgent` is called. The webhook keeps saving the
placeholder (`[imagem]` or caption) exactly as it does today.

**New module** — `apps/worker/src/lib/image-description.ts`:

```ts
export async function describeImageMessage(params: {
  instanceName: string;
  evolutionMessageId: string;
  caption?: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
```

Internally: calls Evolution's `getBase64FromMediaMessage` (no
`convertToMp4`), checks the returned `size` against a cap (see below),
builds a `createModel(provider, model, apiKey)` instance, calls
`generateText` with the image + a Portuguese prompt instructing a natural,
human-like description, prioritizing brand/model/color/visible condition
when the photo is of a motorcycle, and folding in `caption` as extra context
when present (e.g. the customer wrote "quanto vale essa?" alongside the
photo). Any failure at any step (Evolution error, size cap exceeded, model
error — including a model that doesn't support vision, empty response) is
caught internally and turned into `{ ok: false, reason }`, mirroring
`transcribeAudioMessage`'s contract exactly — the caller never has to know
which step failed.

**Wiring into `process-message.ts`** — parallel to the existing audio
branch:

```ts
if (currentMessage.media_type === "image") {
  const description = await describeImageMessage({
    instanceName: instance.instance_name,
    evolutionMessageId: currentMessage.evolution_message_id!,
    // The webhook stores the literal placeholder "[imagem]" when the
    // customer sent no caption — don't forward that literal string as if
    // it were real context.
    caption: currentMessage.content === "[imagem]" ? undefined : currentMessage.content,
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
```

`IMAGE_FALLBACK_TEXT` — a new fixed constant next to `AUDIO_FALLBACK_TEXT`:
"Desculpa, não consegui analisar essa imagem 🙏 Pode me contar em texto o
que tem nela?". Same deterministic-on-failure reasoning as audio: no risk of
the model inventing content when there's nothing real to work with.

**Size cap** — 10 MB, read from the `size` field in Evolution's response
after fetching (not before, since — unlike audio's `seconds` field — no
webhook-provided size field was confirmed to exist for images; adding one
would require an unverified assumption about the WhatsApp/Baileys payload).
This still avoids the expensive step (the vision model call) even though
the Evolution round trip itself already happened.

**Reused, not new:** `updateMessageContent` (already added by the audio
feature in `packages/database/src/queries/messages.ts`), `resolveApiKey`
and `createModel` (already exported from `@aula-agente/agent-runtime`),
`sendFallbackText` (already a local helper in `process-message.ts`).

**Schema/type changes:** none needed — `media_type: "image"` and the
`imageMessage.caption` extraction already exist in
`packages/shared/src/schemas/evolution.ts` and
`apps/api/src/routes/webhooks/evolution.ts`.

**Dashboard display** — no code change needed, same reasoning as audio:
`updateMessageContent` overwrites the row Realtime already pushes to the
Inbox, so `"📷 <description>"` replaces `[imagem]` in place once the worker
finishes.

## Data flow example

1. Customer sends a photo of their Bros 160 with the caption "quanto vale
   essa?".
2. Webhook saves a `contact` message: `content: "quanto vale essa?"`,
   `media_type: "image"`. Fast ack to Evolution, as today.
3. `process-message` picks up the job, sees `media_type === "image"`.
4. Calls `describeImageMessage` with the org's already-resolved
   `agent.provider`/`agent.model`/`apiKey`, the caption as context. Gets
   back: `"Foto de uma Honda Bros 160 vermelha, ano aparentemente recente,
   com alguns riscos leves na lateral direita do tanque."`
5. Updates the message row's content to `"📷 Foto de uma Honda Bros 160
   vermelha... quanto vale essa?"` — Inbox now shows real text instead of
   `[imagem]`.
6. Runs the agent with that text as the effective message content — from
   here on, indistinguishable from a typed message. Agent replies normally,
   possibly calling `searchCatalog` to compare trade-in values.

If step 4 fails (Evolution can't fetch the image, the org's model doesn't
support vision, image over 10 MB, network error): message row stays at the
original placeholder/caption, the agent is never called, and the customer
gets "Desculpa, não consegui analisar essa imagem 🙏 Pode me contar em texto
o que tem nela?" instead.

## Testing

- `describeImageMessage`'s internal helpers (Evolution response parsing,
  size cap check, the `generateText` call, and the try/catch reduction to
  `{ok, text|reason}`) are unit-testable by injecting a fetch/`generateText`
  mock, following the same style as `audio-transcription.test.ts`.
- New cases in `process-message.test.ts` (or wherever the audio branch is
  tested) for the image branch: success updates the message and proceeds to
  `runAgent`; failure sends the fallback and skips `runAgent` entirely.
- The actual live Evolution + vision-model calls, and the `process-message.ts`
  wiring end-to-end, are verified manually against the real running
  services — same precedent as the rest of this project (external I/O isn't
  unit tested here, it's verified live via synthetic webhook posts to the
  real `/webhooks/evolution` endpoint using the safe test number).
