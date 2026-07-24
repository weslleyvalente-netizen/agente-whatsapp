# Audio Transcription for the WhatsApp Agent — Design

## Goal

When a customer sends a WhatsApp voice note, transcribe it to text and let
the agent respond to it like any other message, instead of only seeing the
`[audio]` placeholder it gets today.

## Non-goals

- No support for other media types (image/video/document) beyond the
  existing placeholders — this pass is audio only.
- No local audio transcoding dependency (ffmpeg, etc.) in our own
  Docker images — Evolution API already converts audio to a
  Whisper-compatible format server-side (see below), so nothing new is
  installed.
- No persisting or serving the raw audio file for playback in the
  dashboard — only the transcribed text is kept. Adding audio playback in
  the Inbox is a separate, larger feature (needs file storage) and isn't
  part of this pass.
- No per-agent opt-in toggle. Unlike `searchFaq`/`searchCatalog`, this
  isn't a tool the model chooses to call — it's a pipeline step that runs
  automatically before the agent ever sees the message, so it applies to
  every agent/organization unconditionally, the same way the accent-
  insensitive catalog search fix does.
- No provider choice beyond OpenAI Whisper for this pass, per explicit
  decision.

## Confirmed external contracts

Both verified against source/docs before writing this spec (not assumed):

**Fetching the audio from Evolution API** — `POST
{EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/{instanceName}`, header
`apikey: {EVOLUTION_API_KEY}`, JSON body `{ "message": { "key": { "id":
"<evolutionMessageId>" } }, "convertToMp4": true }`. Evolution looks the
original message up server-side by `key.id` alone (confirmed in Evolution's
own source — it queries its own message store by `key->>'id'`, so no other
key fields are required). `convertToMp4: true` matters: WhatsApp voice
notes are OGG/Opus, a format OpenAI's transcription API handles
inconsistently in practice (community-reported failures specifically with
Opus-in-OGG). Evolution already ships its own bundled `ffmpeg` and uses it
internally for this flag — passing it gets back audio already transcoded
to AAC/`audio/mp4`, which is on Whisper's officially supported list, with
zero new dependencies on our side. Response: `{ mediaType, fileName,
caption, size: {...}, mimetype: "audio/mp4", base64 }`.

**Transcribing with OpenAI** — `POST
https://api.openai.com/v1/audio/transcriptions`, header `Authorization:
Bearer {OPENAI_API_KEY}`, `multipart/form-data` body with fields `file`
(the audio binary, decoded from the base64 above), `model=whisper-1`,
`language=pt`. Response (default `response_format=json`): `{ "text":
"<transcribed text>" }`.

**Voice note duration** — already present in the original webhook payload
we receive today, in `data.message.audioMessage.seconds` (a Baileys/
WhatsApp field) — our schema currently stubs `audioMessage` as `z.object({})`
and discards it. No extra API call needed to know how long a voice note is.

## Architecture

**Where it runs** — inside `process-message.ts` (`apps/worker`), after the
message is loaded but before `runAgent` is called. The webhook keeps saving
the placeholder `[audio]` exactly as it does today (webhook stays fast,
independent of transcription latency); the worker — which already runs
per-message in the background — is where the real content gets filled in.

**New module** — `apps/worker/src/lib/audio-transcription.ts`:

```ts
export async function transcribeAudioMessage(params: {
  instanceName: string;
  evolutionMessageId: string;
  apiKey: string; // OpenAI key, resolved by the caller
}): Promise<{ ok: true; text: string } | { ok: false, reason: string }>
```

Internally: calls Evolution's `getBase64FromMediaMessage` with
`convertToMp4: true`, decodes the returned base64 to a `Buffer`, uploads it
to OpenAI's transcription endpoint, and returns `{ ok: true, text }` on
success. Any failure at any step (Evolution error, empty/whitespace
transcription, network error, OpenAI error — including the known Evolution
bug where iOS-recorded audio can return an `ephemeralMessage` error) is
caught internally and turned into `{ ok: false, reason }` — the caller
never has to know which step failed, only whether it succeeded.

**Wiring into `process-message.ts`** — right before the existing
"remove current message from history" step:

```ts
let effectiveMessage = currentMessage;

if (currentMessage.media_type === "audio") {
  const durationSeconds = currentMessage.metadata?.duration_seconds;

  if (typeof durationSeconds === "number" && durationSeconds > 300) {
    await sendTypeInsteadFallback(db, sendQueue, { conversationId, instanceId: instance.id, phone, organizationId });
    return;
  }

  const openaiKey = await resolveApiKey(organizationId, "openai");
  const transcription = await transcribeAudioMessage({
    instanceName: instance.instance_name,
    evolutionMessageId: currentMessage.evolution_message_id!,
    apiKey: openaiKey,
  });

  if (!transcription.ok) {
    await sendTypeInsteadFallback(db, sendQueue, { conversationId, instanceId: instance.id, phone, organizationId });
    return;
  }

  await updateMessageContent(db, currentMessage.id, transcription.text);
  effectiveMessage = { ...currentMessage, content: transcription.text };
}
```

`effectiveMessage` (not `currentMessage`) is what gets passed to `runAgent`
and used in the rest of the function from this point on. Reusing
`resolveApiKey(organizationId, "openai")` — already exported from
`apps/worker/src/lib/vault.ts` — means no new secret-handling code: it
already checks a per-org override in `organization_secrets` before falling
back to the global `OPENAI_API_KEY` env var, exactly like it does for
`anthropic`/`google` today.

`sendTypeInsteadFallback` is a small local helper function defined directly
in `process-message.ts` (it's only used there, no need for its own file)
that saves an `agent`-role message with a fixed text ("Desculpa, não
consegui entender esse áudio 🙏 Pode escrever a mensagem, por favor?") via
`createMessage` and enqueues it on the send queue, the same two calls
`process-message.ts` already makes for a normal LLM reply. This bypasses
the LLM entirely on failure — deterministic, no risk of the model
inventing something when it has no real content to work with.

**Duration cap** — 300 seconds (5 minutes), read directly from the
webhook-provided `seconds` field, no extra API round trip for the reject
case.

**Schema/type changes:**
- `evolutionWebhookPayloadSchema` (`packages/shared/src/schemas/evolution.ts`):
  `audioMessage` becomes `z.object({ seconds: z.number().optional() }).passthrough().optional()`.
- `extractMessageContent` (`apps/api/src/routes/webhooks/evolution.ts`):
  for the `audioMessage` case, additionally read `message.audioMessage?.seconds`
  and return it as a new optional field on its result so the webhook handler
  can pass it into `saveMessage`'s `metadata` as `{ duration_seconds }`.
- `MessageMetadata` (`packages/shared/src/types/message.ts`): gains an
  optional `duration_seconds?: number`.
- `packages/database/src/queries/messages.ts`: new `updateMessageContent(client, id, content)`,
  a plain `.update({ content }).eq("id", id)` — the one new DB query this
  feature needs.

**Dashboard display** — no code change needed. `updateMessageContent`
overwrites the same row Realtime already pushes to the Inbox, so the
transcribed text ("🎤 Vocês têm bicicleta elétrica?" — prefixed with a mic
emoji so a human scanning the Inbox can tell it started as a voice note)
simply replaces `[audio]` in place once the worker finishes.

## Data flow example

1. Customer sends a 12-second voice note asking about the Bros 160.
2. Webhook saves a `contact` message: `content: "[audio]"`, `media_type: "audio"`,
   `metadata: { duration_seconds: 12 }`. Fast ack to Evolution, as today.
3. `process-message` picks up the job, sees `media_type === "audio"`,
   `12 <= 300` so no cap hit.
4. Resolves the org's OpenAI key, calls Evolution for the MP4-converted
   audio, uploads it to Whisper. Gets back `"Vocês têm a Bros 160?"`.
5. Updates the message row's content to `"🎤 Vocês têm a Bros 160?"` — Inbox
   now shows real text instead of `[audio]`.
6. Runs the agent with that text as the effective message content — from
   here on, it's indistinguishable from a typed message. Agent replies
   normally, possibly calling `searchCatalog`/`sendVehiclePhoto` as usual.

If step 4 fails (Evolution can't decrypt the audio, Whisper rejects it,
network error): message row stays `[audio]`, the agent is never called,
and the customer gets "Desculpa, não consegui entender esse áudio 🙏 Pode
escrever a mensagem, por favor?" instead.

If the voice note is 6 minutes long: step 3's cap check fires before any
external call is made, and the customer gets the same fallback message
immediately.

## Testing

- `transcribeAudioMessage`'s internal helpers (the Evolution response
  parsing, the Whisper multipart request building, and the try/catch
  reduction to `{ok, text|reason}`) are unit-testable by injecting a fetch
  mock, following the same style already used in this codebase
  (`apps/api/src/integrations/crm-sync.test.ts` mocks its external
  dependency the same way).
- `extractMessageContent`'s new duration-extraction behavior gets new
  cases in the existing `apps/api/src/routes/webhooks/evolution.test.ts`.
- The actual live Evolution/OpenAI calls, and the `process-message.ts`
  wiring end-to-end, are verified manually against the real running
  services — same precedent as the rest of this project (external I/O
  isn't unit tested here, it's verified live via synthetic webhook posts
  to the real `/webhooks/evolution` endpoint using the safe test number).
