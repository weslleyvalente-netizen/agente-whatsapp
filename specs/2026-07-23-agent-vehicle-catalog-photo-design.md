# Agent Vehicle Catalog Photo — Design

## Goal

Give the AI agent (Helena, or any agent that opts in) the ability to search the
Moto e Trilha vehicle catalog and send a customer the vehicle's main photo as
a real WhatsApp image message — not a text link — when a customer asks about
a specific vehicle.

## Non-goals

- No gallery/multiple photos per vehicle — only the main photo (`imageUrl`),
  per explicit decision.
- No configurable catalog URL per organization/agent — the Moto e Trilha
  catalog URL is hardcoded for this pass. Generalizing to a per-org setting
  is a future decision if another tenant needs the same capability.
- No changes to the catalog site itself — it's an existing, external,
  already-working site (`catalogomotoetrilha.manus.space`), read-only from
  our side.

## Confirmed external contracts

Both verified live against the real, running services (not assumed from
docs) before writing this spec:

**Catalog search** — `GET https://catalogomotoetrilha.manus.space/api/trpc/vehicles.list?batch=1&input={URL-encoded JSON}`, where the JSON is `{"0":{"json":{"search":"<query>"}}}`. Empty string returns all 27 vehicles. Response: `[{"result":{"data":{"json": [Vehicle, ...]}}}]` where each `Vehicle` has (at least): `id` (number), `modelo` (string), `marca` (string), `ano` (number), `quilometragem` (number), `cor` (string), `preco` (number, in reais, no decimals — e.g. `28900` means R$28.900), `descricao` (string | null), `imageUrl` (string, **relative** path like `/manus-storage/vehicles/...`), `tipo` (`"moto" | "carro" | "eletrico"`), `status` (string).

**Sending an image via WhatsApp** — `POST {EVOLUTION_API_URL}/message/sendMedia/{instanceName}`, header `apikey: {EVOLUTION_API_KEY}`, JSON body `{ "number": "<phone>", "mediatype": "image", "media": "<fully-qualified image URL>", "caption": "<text>" }`. Confirmed live: Evolution downloads the URL server-side and delivers a native WhatsApp image message (`messageType: "imageMessage"`) — the `media` field accepts a plain URL string directly, no base64/multipart needed.

## Architecture

Two new agent tools, following the exact pattern of the existing `searchFaq`/`searchKnowledge` tools (Vercel AI SDK `tool()` with a zod `inputSchema` and an `execute` function), registered in `apps/worker/src/agents/tools/registry.ts` and gated by a new `tools_config.send_catalog_photo` boolean (same shape as the two existing toggles).

**`searchCatalog`** — pure read, no side effects. Input: `{ query: string }`. Calls the tRPC endpoint with that query, and returns up to 5 matches to the model as a formatted list: model name, brand, year, price (formatted as `R$ 28.900`), and the **fully-qualified** image URL (`https://catalogomotoetrilha.manus.space` + the relative `imageUrl` — resolved here, not left for the model to construct, since models are unreliable at precise string concatenation). If zero matches, says so plainly so the agent can tell the customer honestly.

**`sendVehiclePhoto`** — has the real-world side effect. Input: `{ modelo: string, preco: number, imageUrl: string }` — the model fills these in directly from a prior `searchCatalog` result, so there's no second lookup and no id-matching to get wrong. It:
1. Builds a caption: `"{modelo} — R$ {preco formatted}"`.
2. Saves a `messages` row (`role: "agent"`, `content`: the caption, `media_url`: the image URL, `media_type: "image"`) via the existing `createMessage` helper, so the sent photo shows up in the Inbox conversation history exactly like a text reply does today.
3. Enqueues a send job carrying the media fields (see below) instead of calling Evolution directly from inside the tool — keeps the tool itself free of retry/rate-limit concerns, consistent with how the text-reply path already works (`process-message` enqueues, `send-message` worker actually calls Evolution).
4. Returns a short confirmation to the model (`"Foto enviada."`) so it can continue its reply naturally (e.g., "Segue a foto! Quer que eu marque uma visita pra ver ao vivo?").

**Tool context** — today `buildToolsForAgent`'s params are `{ organizationId, agentId, toolsConfig, apiKey }`. `sendVehiclePhoto` additionally needs the conversation's recipient phone and instance id to enqueue the send job, and the conversation id + organization id to save the message row. These aren't available where `buildToolsForAgent` is currently called (inside `runAgent`, which doesn't receive them today) — `process-message.ts` already has the conversation and instance loaded, so it passes them down through `runAgent` → `buildToolsForAgent`.

**Send pipeline extension** — `SendMessageJobData` (in `packages/queue/src/types.ts`) gains three optional fields: `mediaUrl?: string`, `mediaType?: "image"`, and `caption?: string`. The `send-message` worker (`apps/worker/src/workers/send-message.ts`) branches: if `mediaUrl` is present, call the (new) `sendEvolutionMedia` helper against `/message/sendMedia/{instance}` with the confirmed JSON contract above; otherwise, unchanged existing `sendEvolutionText` path. `content` stays the human-readable caption either way, so existing job-data consumers aren't broken.

**Inbox display** — `message-bubble.tsx` currently renders only `message.content` as plain text. When `media_type === "image"`, render the image (`<img src={media_url}>`) above the caption text, so a photo Helena sent is actually visible in the dashboard, not just a caption with no picture.

**Agent settings UI** — `agent-form.tsx` gets a third toggle next to "Busca na Base de Conhecimento" / "Busca de FAQs": "Catálogo de Veículos (Moto e Trilha)", bound to `tools_config.send_catalog_photo`.

## Data flow example

1. Customer: "vocês têm a Bros 160?"
2. Agent calls `searchCatalog({ query: "Bros 160" })` → gets back one match: BROS 160 ESDD ABS, 2026, R$ 28.900, `https://catalogomotoetrilha.manus.space/manus-storage/vehicles/1782478829982_cdf6b513.png`.
3. Exactly one match, so the agent calls `sendVehiclePhoto({ modelo: "BROS 160 ESDD ABS", preco: 28900, imageUrl: "https://catalogomotoetrilha.manus.space/manus-storage/vehicles/1782478829982_cdf6b513.png" })`.
4. Customer receives the actual photo on WhatsApp with the caption "BROS 160 ESDD ABS — R$ 28.900".
5. Agent's text reply follows normally, e.g. "Essa é a Bros 160 ESDD ABS por R$ 28.900! Quer saber mais sobre financiamento?"
6. If the customer had asked something vaguer ("tem moto barata?"), `searchCatalog` would return several matches, and per the earlier decision, the agent asks which one before calling `sendVehiclePhoto` at all.

## Testing

- `searchCatalog` and the caption/price-formatting logic inside `sendVehiclePhoto` are pure functions (given a fixed HTTP response, format the output) — unit-testable with vitest, following the same style as `apps/api/src/routes/dashboard/dashboard.test.ts`.
- The `send-message` worker's new media branch and the live Evolution/catalog calls are verified manually against the real running services (same precedent as the rest of this project — Fastify routes with external I/O aren't unit tested here).
