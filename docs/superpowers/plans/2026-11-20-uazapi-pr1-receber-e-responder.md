# UAZAPI — PR 1: receber e responder (virada direta) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O CRM recebe e responde clientes pela UAZAPI quando a instância estiver com `provider = 'uazapi'`, e volta para a Evolution trocando só esse campo.

**Architecture:** Uma rota nova `/webhooks/uazapi` autentica o evento, traduz para o formato que a rota da Evolution já aceita e o repassa por `app.inject` para `/webhooks/evolution` com um cabeçalho interno de repasse; a rota da Evolution passa a aceitar só eventos do provedor ativo da instância. Na saída, os pontos que chamam a Evolution (envio, download de mídia, foto) consultam o provedor da instância e, se for UAZAPI, usam um cliente novo em `packages/agent-runtime/src/whatsapp/`. O token da instância UAZAPI fica no banco cifrado com uma chave derivada do `UAZAPI_ADMIN_TOKEN`.

**Tech Stack:** TypeScript, Fastify (api), BullMQ (worker), Next.js (web), Supabase/Postgres, Vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-11-20-uazapi-provedor-whatsapp-design.md`

## Global Constraints

- Servidor UAZAPI do dono: `https://motoetrilha.uazapi.com` (entra como `UAZAPI_BASE_URL`; nunca fixo no código).
- Variáveis novas (api e worker): `UAZAPI_BASE_URL`, `UAZAPI_ADMIN_TOKEN`; só na api: `API_PUBLIC_URL` (endereço HTTPS público da API, o mesmo de `NEXT_PUBLIC_API_URL` da web). Sem `UAZAPI_*` tudo funciona como hoje.
- Cabeçalhos UAZAPI: `token` (instância) e `admintoken` (administração). O token de administrador nunca sai do servidor.
- Nada de conteúdo de mensagem, telefone ou token em logs (só os 4 últimos dígitos, como já é feito).
- Comportamento da Evolution sem mudança enquanto `provider = 'evolution'` (é o default).
- Nunca apagar a linha de `evolution_instances` (cascata nas conversas).
- `messageTimestamp` da UAZAPI vem em milissegundos; `Timestamp` do recibo vem em segundos. O formato interno usa segundos.
- O id do WhatsApp é `message.messageid` (não `message.id`); vai para `evolution_message_id`.
- Limite UAZAPI: 429 com `Retry-After`: espera uma vez (no máximo 5 s) e tenta de novo; falhou de novo → erro como hoje.
- Textos de interface em português.
- Testes: `pnpm turbo test --concurrency=1 --filter=<pacote>` (o `shared` precisa estar compilado; o turbo faz isso).

## Review Focus

1. Evento UAZAPI de instância ainda em `'evolution'` (UAZAPI conectada antes da virada) → 200 e nada gravado; a Evolution continua sozinha. Teste na Task 5.
2. Webhook com `apikey` certo mas `token` de outra instância (ou instância sem token guardado) → 401 sem gravar. Teste na Task 5.
3. Instância em `'uazapi'` sem `provider_token_encrypted` (virada sem conectar) ou `UAZAPI_ADMIN_TOKEN` trocado → envio falha com erro claro e cai no fluxo normal de falha de envio (`reportSendFailure`), sem travar a fila. Teste na Task 3 e na Task 4.
4. Eco do envio pela API (`fromMe: true`, `wasSentByApi: true`) chegando antes de o worker gravar o id → mesmo id do WhatsApp e `fromMe` preservados na tradução, para a corrida de eco existente casar. Teste na Task 2.
5. Mídia maior que o limite → o download pela `fileURL` respeita `maxBytes` (Content-Length e leitura com teto) e lança `EvolutionMediaTooLargeError`, como hoje. Teste na Task 3.

---

### Task 1: Esquema, tipos e consultas da instância

**Files:**
- Create: `supabase/migrations/20261120140000_whatsapp_provider.sql`
- Modify: `packages/shared/src/types/evolution.ts` (interface `EvolutionInstance`)
- Modify: `packages/database/src/queries/evolution-instances.ts`
- Test: `packages/database/src/sql/whatsapp-provider.test.ts`

**Interfaces:**
- Produces:
  - Colunas `evolution_instances.provider text NOT NULL DEFAULT 'evolution' CHECK (provider IN ('evolution','uazapi'))` e `evolution_instances.provider_token_encrypted text NULL`.
  - `EvolutionInstance` ganha `provider?: "evolution" | "uazapi"` e `provider_token_encrypted?: string | null` (opcionais: o código roda antes da migração; ausente = `"evolution"`).
  - `getInstanceByInstanceName(client: SupabaseClient, instanceName: string): Promise<EvolutionInstance | null>` (null se não existir).
  - `setInstanceProviderFields(client: SupabaseClient, id: string, fields: { provider?: "evolution" | "uazapi"; provider_token_encrypted?: string | null }): Promise<void>`.

- [ ] **Step 1: Teste da migração** (`createTestDb(["20261120140000_whatsapp_provider.sql"])`; o fixture já tem `evolution_instances`):
  - `"instância nova fica em 'evolution' e sem token"`: insere uma linha e espera `provider = 'evolution'` e `provider_token_encrypted = null`.
  - `"aceita 'uazapi' e recusa outro valor"`: update para `'uazapi'` passa; update para `'zapi'` lança erro de check.
  - Se o fixture não tiver `evolution_instances`, criar a tabela mínima no próprio teste antes de aplicar a migração (colunas `id uuid`, `organization_id uuid`, `instance_name text`, `instance_id text`).
- [ ] **Step 2:** `pnpm turbo test --concurrency=1 --filter=@aula-agente/database -- whatsapp-provider` → FALHA (arquivo de migração não existe; o harness pula arquivo ausente, então a coluna não existe).
- [ ] **Step 3:** Escrever a migração com `SET LOCAL lock_timeout = '5s';` e `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` para as duas colunas e a constraint nomeada `evolution_instances_provider_check`. Atualizar o tipo e as duas consultas.
- [ ] **Step 4:** Rodar o teste → PASSA.
- [ ] **Step 5:** Commit `feat(db): provedor de WhatsApp por instância (evolution|uazapi)`.

### Task 2: Tradução de eventos UAZAPI (função pura)

**Files:**
- Create: `packages/shared/src/uazapi/translate.ts`
- Modify: `packages/shared/src/index.ts` (exportar)
- Test: `packages/shared/src/uazapi/translate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UazapiTranslation =
    | { kind: "message"; payload: EvolutionLikeMessageEvent; messageType: string; recognized: boolean }
    | { kind: "status"; events: Array<{ event: "messages.update"; instance: string; data: { keyId: string; status: "DELIVERY_ACK" | "READ" | "PLAYED" } }> }
    | { kind: "connection"; status: string | null }
    | { kind: "ignored"; reason: "group" | "unsupported_event" | "invalid" };
  export function translateUazapiEvent(body: unknown, instanceId: string): UazapiTranslation;
  export function describeShape(value: unknown, depth?: number): unknown; // chaves e tipos, nunca valores; depth padrão 3
  ```
  `EvolutionLikeMessageEvent` = o tipo inferido de `evolutionWebhookPayloadSchema` (`z.infer`), com `event: "messages.upsert"` e `instance: instanceId`.

Regras (do spec, seção "Entrada"):
- `EventType` `messages` → `data.key = { remoteJid: chatid, remoteJidAlt, fromMe, id: messageid }`, `pushName = senderName ?? null`, `messageTimestamp = Math.floor(ms / 1000)` (ausente/inválido → omitido).
- `remoteJidAlt`: só quando `chatid` termina em `@lid`: `sender_pn` se `!fromMe`; senão `chat.wa_chatid` se terminar em `@s.whatsapp.net`; senão `null`.
- Tipo: primeira letra minúscula de `messageType` (`ImageMessage` → `imageMessage`). `Conversation` e `ExtendedTextMessage` → `messageType: "conversation"`, `message: { conversation: text }`. Mídias conhecidas (`imageMessage`, `videoMessage`, `audioMessage`, `documentMessage`, `documentWithCaptionMessage` → vira `documentMessage`, `stickerMessage`, `locationMessage`, `reactionMessage`, `protocolMessage`): `message = { [tipo]: { ...content com chaves de primeira letra minúscula, recursivo, caption: text || content.caption } }`; áudio leva `seconds`, documento leva `fileName` (`fileName` ou `title`). `recognized = false` para tipo fora dessa lista (passa com `message: {}` e o tipo original: o handler grava "[mensagem não suportada]").
- Anúncio: `content.contextInfo.externalAdReply` (após normalizar chaves) → `data.contextInfo = { externalAdReply }`.
- `isGroup` ou `chatid` `@g.us` → `{ kind: "ignored", reason: "group" }`.
- `messages_update` com `type === "ReadReceipt"` e `state` em `Delivered|Read|Played` → um evento por `event.MessageIDs[i]` (status `DELIVERY_ACK|READ|PLAYED`; sem `fromMe`, que o parser tolera). Outro tipo → `ignored/unsupported_event`.
- `connection` → `{ kind: "connection", status: instance.status ?? null }`.
- Demais `EventType` → `ignored/unsupported_event`; corpo sem `EventType` ou sem `message` → `ignored/invalid`.

- [ ] **Step 1: Testes** (payloads montados a partir do exemplo da documentação, valores fictícios):
  - texto: `messageType "Conversation"`, `text "Olá"`, `messageTimestamp 1788868800000` → `payload.data.message.conversation === "Olá"`, `messageTimestamp === 1788868800`, `key.id === messageid`, e `evolutionWebhookPayloadSchema.safeParse(payload).success === true`.
  - `@lid` recebido com `sender_pn "5562999990000@s.whatsapp.net"` → `remoteJidAlt` igual a ele.
  - `@lid` `fromMe` com `chat.wa_chatid "5562999990000@s.whatsapp.net"` → `remoteJidAlt` igual a ele.
  - eco da API: `fromMe: true, wasSentByApi: true, messageid "3EB0ABC"` → `key.fromMe === true`, `key.id === "3EB0ABC"`.
  - imagem com legenda em `text` → `messageType "imageMessage"`, `message.imageMessage.caption === "foto da moto"`.
  - áudio com `content: { Seconds: 7, FileLength: "12345" }` → `message.audioMessage.seconds === 7`, `fileLength === "12345"`.
  - documento com `content: { fileName: "rg.pdf" }` → `message.documentMessage.fileName === "rg.pdf"`.
  - anúncio: `content: { ContextInfo: { ExternalAdReply: { Title: "Fazer 250", Body: "Condição" } } }` → `contextInfo.externalAdReply` com `title` e `body`.
  - tipo desconhecido `"PollCreationMessage"` → `recognized === false`, `messageType === "pollCreationMessage"`.
  - grupo → `ignored/group`.
  - `messages_update` `ReadReceipt` `state "Read"` com dois ids → dois eventos `READ`, e cada um passa em `parseEvolutionStatusUpdate` com `messageId` igual ao id.
  - `connection` com `instance.status "disconnected"` → `{ kind: "connection", status: "disconnected" }`.
  - `describeShape({ a: "x", b: { c: 1 }, d: [true] })` → `{ a: "string", b: { c: "number" }, d: ["boolean"] }` e nenhum valor original aparece no JSON resultante.
- [ ] **Step 2:** `pnpm turbo test --concurrency=1 --filter=@aula-agente/shared -- uazapi` → FALHA.
- [ ] **Step 3:** Implementar `translate.ts`.
- [ ] **Step 4:** Rodar → PASSA.
- [ ] **Step 5:** Commit `feat(shared): tradução de eventos UAZAPI para o formato interno`.

### Task 3: Cliente UAZAPI, token cifrado e escolha do provedor

**Files:**
- Create: `packages/agent-runtime/src/whatsapp/uazapi.ts`
- Create: `packages/agent-runtime/src/whatsapp/instance-token.ts`
- Create: `packages/agent-runtime/src/whatsapp/target.ts`
- Modify: `packages/agent-runtime/src/index.ts` (exportar os três)
- Test: `packages/agent-runtime/src/whatsapp/uazapi.test.ts`, `instance-token.test.ts`, `target.test.ts`

**Interfaces:**
- Produces (`instance-token.ts`):
  - `encryptInstanceToken(plain: string): string` e `decryptInstanceToken(stored: string): string`. AES-256-GCM, formato `iv:tag:cipher` em hex (igual a `packages/database/src/crypto/cpf.ts`), chave = `sha256("aula-agente/uazapi-instance-token/v1\0" + UAZAPI_ADMIN_TOKEN)`. Sem `UAZAPI_ADMIN_TOKEN` → `Error("UAZAPI_ADMIN_TOKEN não configurado")`. Decifrar com outra chave → `Error("token da instância UAZAPI ilegível (token de administrador trocado?)")`.
- Produces (`target.ts`):
  ```ts
  export type WhatsAppTarget = { provider: "evolution"; instanceName: string } | { provider: "uazapi"; instanceName: string; token: string };
  export function targetFromInstance(row: { instance_name: string; provider?: string | null; provider_token_encrypted?: string | null }): WhatsAppTarget;
  export async function resolveWhatsAppTarget(instanceName: string): Promise<WhatsAppTarget>; // lê evolution_instances por instance_name (getInstanceByInstanceName), cache de 30 s por nome
  export function resetWhatsAppTargetCache(): void;
  ```
  `targetFromInstance` com `provider "uazapi"` e token ausente → `Error("instância em UAZAPI sem token: conecte a UAZAPI antes de virar")`. Linha não encontrada em `resolveWhatsAppTarget` → `{ provider: "evolution", instanceName }` (comportamento de hoje).
- Produces (`uazapi.ts`), todas com `UAZAPI_BASE_URL` sem barra final e erro `UazapiHttpError(status, body)` (mensagem `UAZAPI error ${status}: ${body}`) em resposta não-OK, após a regra do 429:
  - `uazapiSendText(token: string, phone: string, text: string, signal?: AbortSignal): Promise<{ key: { id: string | null } }>` → `POST /send/text` `{ number, text }`; `key.id = response.messageid ?? null` (formato da resposta da Evolution, para o worker não mudar).
  - `uazapiSendMedia(token: string, phone: string, media: { type: "image" | "video" | "document" | "ptt"; file: string; caption?: string; docName?: string; mimetype?: string }): Promise<{ key: { id: string | null } }>` → `POST /send/media` `{ number, type, file, text: caption, docName, mimetype }` (campos ausentes não vão).
  - `uazapiDownloadMedia(token: string, messageId: string, opts: { timeoutMs: number; maxBytes?: number; mp3?: boolean }): Promise<{ base64: string; mimetype: string }>` → `POST /message/download` `{ id: messageId, generate_mp3: opts.mp3 ?? false, return_link: true }`, depois `GET fileURL` com Content-Length > `maxBytes` → `EvolutionMediaTooLargeError(len)` antes de ler, e leitura com teto (`maxBytes`) que também lança `EvolutionMediaTooLargeError`.
  - `uazapiAvatarUrl(token: string, phone: string): Promise<string | null>` → `POST /chat/avatar` `{ number, preview: true }`; `""` → `null`.
  - Administração: `uazapiCreateInstance(name: string): Promise<{ token: string }>` (`POST /instance/create`, `admintoken`), `uazapiSetWebhook(token: string, url: string): Promise<void>` (`POST /webhook` `{ enabled: true, url, events: ["messages", "messages_update", "connection"], excludeMessages: ["isGroupYes"] }`), `uazapiConnect(token: string, phone?: string): Promise<UazapiConnectionInfo>` (`POST /instance/connect`, `{ phone }` só se veio; 409 → devolve `uazapiStatus`), `uazapiStatus(token: string): Promise<UazapiConnectionInfo>` (`GET /instance/status`).
  - `type UazapiConnectionInfo = { status: "disconnected" | "connecting" | "connected" | "hibernated" | string; qrcode: string | null; paircode: string | null }` (lido de `instance.status`, `instance.qrcode`, `instance.paircode`).

- [ ] **Step 1: Testes** (mockando `globalThis.fetch` como os testes atuais fazem):
  - token: cifra e decifra; sem `UAZAPI_ADMIN_TOKEN` lança a mensagem acima; trocar o admin token entre cifrar e decifrar lança "ilegível".
  - `uazapiSendText`: chama `${UAZAPI_BASE_URL}/send/text` com cabeçalho `token` e corpo `{ number: "5562999990000", text: "oi" }`; resposta `{ messageid: "3EB0X" }` → `{ key: { id: "3EB0X" } }`.
  - 429 com `Retry-After: 1` e depois 200 → duas chamadas e sucesso; 429 duas vezes → `UazapiHttpError` com status 429.
  - 500 → `UazapiHttpError` e a mensagem contém `500`.
  - `uazapiDownloadMedia` com Content-Length 10_000 e `maxBytes 1_000` → `EvolutionMediaTooLargeError`; com 500 bytes → `{ base64, mimetype }` do corpo baixado e `mimetype` vindo de `/message/download`.
  - `uazapiAvatarUrl` com `{ url: "" }` → `null`.
  - `uazapiConnect` com 409 → chama `/instance/status` e devolve o estado.
  - `targetFromInstance`: sem `provider` → evolution; `uazapi` com token cifrado → token decifrado; `uazapi` sem token → lança a mensagem acima.
  - `resolveWhatsAppTarget` (mock de `@aula-agente/database`): segunda chamada em menos de 30 s não consulta o banco; após `resetWhatsAppTargetCache()` consulta de novo.
- [ ] **Step 2:** `pnpm turbo test --concurrency=1 --filter=@aula-agente/agent-runtime -- whatsapp` → FALHA.
- [ ] **Step 3:** Implementar os três arquivos. `EvolutionMediaTooLargeError` já existe em `audio-transcription.ts`: importar de lá.
- [ ] **Step 4:** Rodar → PASSA.
- [ ] **Step 5:** Commit `feat(agent-runtime): cliente UAZAPI, token cifrado e escolha do provedor`.

### Task 4: Saída pelo provedor ativo (envio, mídia, foto)

**Files:**
- Modify: `apps/worker/src/workers/send-message.ts` (`sendEvolutionText`, `sendEvolutionMedia`, `sendEvolutionAudio`)
- Modify: `packages/agent-runtime/src/audio-transcription.ts` (`fetchAudioAsMp4`, `fetchMediaBase64`)
- Modify: `apps/worker/src/lib/image-description.ts` (`fetchImage` passa a usar `fetchMediaBase64`)
- Modify: `apps/worker/src/lib/profile-picture.ts` (`defaultFetchPictureUrl`)
- Test: `apps/worker/src/workers/send-message-provider.test.ts`, `packages/agent-runtime/src/audio-transcription-provider.test.ts`, `apps/worker/src/lib/profile-picture-provider.test.ts`

**Interfaces:**
- Consumes: `resolveWhatsAppTarget`, `uazapiSendText`, `uazapiSendMedia`, `uazapiDownloadMedia`, `uazapiAvatarUrl`, `UazapiHttpError` (Task 3).
- Produces: as funções mantêm nomes e assinaturas; cada uma começa com `const target = await resolveWhatsAppTarget(instanceName)` e, se `target.provider === "uazapi"`, usa o cliente UAZAPI; senão o código atual sem mudança.
  - texto → `uazapiSendText(target.token, phone, text, signal)`.
  - mídia → `uazapiSendMedia(target.token, phone, { type: mediatype ?? "image", file: mediaUrl, caption, docName: fileName, mimetype })`.
  - áudio (base64) → `uazapiSendMedia(target.token, phone, { type: "ptt", file: audioBase64 })`.
  - Erro da UAZAPI no worker → `throw new Error(sanitizeEvolutionError(err.status, err.body))` (mesma mensagem que o fluxo de falha de envio já entende), com as substituições "media send error"/"audio send error" que existem hoje.
  - `fetchAudioAsMp4` → `uazapiDownloadMedia(token, id, { timeoutMs, mp3: true })`; `fetchMediaBase64` → `uazapiDownloadMedia(token, id, { timeoutMs, maxBytes })` (sem `fileName`).
  - foto → `uazapiAvatarUrl(target.token, phone)`.
  - Falha ao resolver o alvo (ex.: instância UAZAPI sem token) → lança; no worker isso cai no `catch` de `processSendMessageJob` e em `reportSendFailure`, como qualquer falha.

- [ ] **Step 1: Testes:**
  - `send-message-provider.test.ts`: com `resolveWhatsAppTarget` mockado para UAZAPI, um job de texto chama `uazapiSendText` e grava `setMessageEvolutionId(db, messageId, "3EB0X")`; com Evolution, chama `fetch` em `${EVOLUTION_API_URL}/message/sendText/inst` (comportamento atual); UAZAPI sem token (alvo lança) → `reportSendFailure` chamado na última tentativa e o job lança; anexo do vendedor (`storedMediaRef`, kind `document`) chama `uazapiSendMedia` com `type "document"` e `docName`.
  - `audio-transcription-provider.test.ts`: alvo UAZAPI → `fetchAudioAsMp4` chama `uazapiDownloadMedia` com `mp3: true`; `fetchMediaBase64` repassa `maxBytes`.
  - `profile-picture-provider.test.ts`: alvo UAZAPI e `uazapiAvatarUrl` devolvendo `null` → resultado `{ ok: true, stored: false }` sem baixar imagem.
- [ ] **Step 2:** Rodar os testes do worker e do agent-runtime → FALHAM.
- [ ] **Step 3:** Implementar. Não mexer em `unanswered-lead-sweep.ts` nem em `health-monitor.ts` (avisos internos; PR 2).
- [ ] **Step 4:** `pnpm turbo test --concurrency=1 --filter=@aula-agente/worker --filter=@aula-agente/agent-runtime` → tudo PASSA (inclusive os testes antigos de envio).
- [ ] **Step 5:** Commit `feat(worker): envio, mídia e foto pelo provedor ativo da instância`.

### Task 5: Entrada `/webhooks/uazapi` e trava de provedor na rota da Evolution

**Files:**
- Create: `apps/api/src/routes/webhooks/uazapi.ts`
- Modify: `apps/api/src/routes/webhooks/evolution.ts` (trava de provedor nos caminhos de mensagem e de status)
- Modify: `apps/api/src/server.ts` (registrar a rota nova)
- Test: `apps/api/src/routes/webhooks/uazapi.test.ts`, `apps/api/src/routes/webhooks/evolution-provider-guard.test.ts`

**Interfaces:**
- Consumes: `translateUazapiEvent`, `describeShape` (Task 2); `decryptInstanceToken` (Task 3); `getInstanceByInstanceName` (Task 1); `REPLAY_TOKEN` (`apps/api/src/lib/replay-token.ts`).
- Produces:
  - `export const PROVIDER_RELAY_HEADER = "x-provider-relay"` em `evolution.ts`, e `isProviderRelay(headers): boolean` (`headers[PROVIDER_RELAY_HEADER] === REPLAY_TOKEN`).
  - Trava na rota da Evolution, logo após achar a instância (mensagem) e dentro do bloco assíncrono de status: `const active = instance.provider ?? "evolution"; const from = isProviderRelay(request.headers) ? "uazapi" : "evolution"; if (active !== from) → 200 { ok: true, skipped: "inactive_provider" }` (no status, só não grava).
  - `POST /webhooks/uazapi` com `preHandler: [webhookVerifyMiddleware]` (segredo em `?apikey=`):
    1. `instanceName` ausente ou instância não encontrada → 200 `{ skipped: "unknown_instance" }`.
    2. Sem `provider_token_encrypted`, ou `body.token` diferente do token decifrado (comparação em tempo constante sobre sha256) → 401.
    3. Log `{ event: "uazapi_event_shape", eventType, messageType, recognized, shape: describeShape(body.message ?? body.event) }` para `messages` e `messages_update`.
    4. `message` → `app.inject({ method: "POST", url: "/webhooks/evolution", headers: { apikey: process.env.WEBHOOK_SECRET ?? "", [PROVIDER_RELAY_HEADER]: REPLAY_TOKEN }, payload })` e devolve o status/corpo do repasse.
    5. `status` → um repasse por evento; responde 200 `{ ok: true, statuses: n }`.
    6. `connection` → log `{ event: "uazapi_connection", instance: instanceName, status }`, 200 (monitor no PR 2).
    7. `ignored` → 200 `{ ok: true, skipped: reason }`.

- [ ] **Step 1: Testes** (padrão de `evolution-lid.test.ts`: Fastify com as DUAS rotas registradas e `@aula-agente/database` mockado):
  - `uazapi.test.ts`:
    - instância `{ provider: "uazapi", provider_token_encrypted: encryptInstanceToken("tok-1") }`, evento de texto com `token "tok-1"` → `saveMessage` chamado com conteúdo `"Olá"` e `enqueueProcessMessage` chamado uma vez.
    - mesmo evento com `token "outro"` → 401 e `saveMessage` não chamado.
    - instância sem token guardado → 401.
    - instância em `"evolution"` com token certo → 200 `skipped: "inactive_provider"` e nada gravado (Review Focus 1).
    - `ReadReceipt` com dois ids → 200 e `applyMessageDeliveryStatus` chamado para os dois ids (aguardar o bloco assíncrono com `vi.waitFor`).
    - grupo → 200 `skipped: "group"`.
    - o log de forma não contém o texto `"Olá"` nem o telefone (capturar o logger do Fastify com um `stream` em memória).
  - `evolution-provider-guard.test.ts`:
    - instância em `"uazapi"` + POST direto em `/webhooks/evolution` → `skipped: "inactive_provider"`, nada gravado.
    - instância sem `provider` (antes da migração) + POST direto → fluxo normal (`saveMessage` chamado).
    - instância em `"evolution"` + POST com cabeçalho de repasse válido → `inactive_provider`.
    - cabeçalho de repasse com valor errado é tratado como Evolution.
- [ ] **Step 2:** `pnpm turbo test --concurrency=1 --filter=@aula-agente/api -- webhooks` → os novos FALHAM.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar a bateria inteira da api (`--filter=@aula-agente/api`) → tudo PASSA, inclusive os 15 arquivos `evolution-*.test.ts` sem alteração.
- [ ] **Step 5:** Commit `feat(api): webhook da UAZAPI reaproveitando o fluxo da Evolution, com trava de provedor`.

### Task 6: Rotas de administração da UAZAPI (conectar, estado, virar)

**Files:**
- Create: `apps/api/src/routes/instances/uazapi.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/instances/uazapi.test.ts`

**Interfaces:**
- Consumes: Task 1 (`getInstanceById`, `setInstanceProviderFields`), Task 3 (`uazapiCreateInstance`, `uazapiSetWebhook`, `uazapiConnect`, `uazapiStatus`, `encryptInstanceToken`, `decryptInstanceToken`, `resetWhatsAppTargetCache`).
- Produces (todas com `authMiddleware`; acesso só para membro da organização da instância com `role !== "agent"`, senão 403):
  - `POST /instances/:instanceId/uazapi/connect` body `{ phone?: string }` (10 a 15 dígitos, senão 400) → sem token guardado: `uazapiCreateInstance(instance.instance_name)` e grava o token cifrado; sempre `uazapiSetWebhook(token, \`${API_PUBLIC_URL}/webhooks/uazapi?apikey=${WEBHOOK_SECRET}\`)`; depois `uazapiConnect(token, phone)` → 200 `UazapiConnectionInfo`. Falta `UAZAPI_BASE_URL`, `UAZAPI_ADMIN_TOKEN`, `API_PUBLIC_URL` ou `WEBHOOK_SECRET` → 503 `{ error: "UAZAPI não configurada no servidor" }` sem chamar nada.
  - `GET /instances/:instanceId/uazapi/status` → `{ provider, connected: boolean, ...UazapiConnectionInfo }`; sem token guardado → `{ provider, connected: false, status: "not_created", qrcode: null, paircode: null }`.
  - `PUT /instances/:instanceId/provider` body `{ provider: "evolution" | "uazapi" }` → para `"uazapi"` exige token guardado e `uazapiStatus` = `connected`, senão 409 `{ error: "UAZAPI não está conectada" }`; grava, chama `resetWhatsAppTargetCache()` e loga `{ event: "whatsapp_provider_switched", instanceId, provider, userId }`. Volta para `"evolution"` nunca é bloqueada.
  - O worker tem cache de 30 s: a troca vale no worker em até 30 s (documentar na resposta: `{ ok: true, provider, effectiveWithinSeconds: 30 }`).

- [ ] **Step 1: Testes:**
  - vendedor (`role "agent"`) → 403 nas três rotas.
  - connect sem token guardado → cria instância, grava token cifrado (o valor gravado ≠ token puro e decifra para ele), registra webhook com URL `https://api.exemplo/webhooks/uazapi?apikey=seg` e devolve o QR.
  - connect com token já guardado → não cria de novo.
  - connect sem `API_PUBLIC_URL` → 503 e nenhuma chamada externa.
  - virar para `uazapi` com status `connecting` → 409 e coluna não muda.
  - virar para `uazapi` conectada → grava e devolve `effectiveWithinSeconds: 30`.
  - voltar para `evolution` → grava sem consultar a UAZAPI.
  - nenhuma resposta contém o token puro.
- [ ] **Step 2:** Rodar → FALHA.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar → PASSA.
- [ ] **Step 5:** Commit `feat(api): conectar e virar instância para a UAZAPI`.

### Task 7: Painel mínimo na tela da instância

**Files:**
- Create: `apps/web/src/components/instances/uazapi-panel.tsx`
- Create: `apps/web/src/components/instances/uazapi-panel-state.ts` (lógica pura)
- Modify: `apps/web/src/app/(dashboard)/instances/[instanceId]/page.tsx` (novo `Card` "WhatsApp pela UAZAPI" abaixo de "Conexao")
- Test: `apps/web/src/components/instances/uazapi-panel-state.test.ts`

**Interfaces:**
- Consumes: as três rotas da Task 6 via `apiFetch`.
- Produces: `describeUazapiPanel(s: { provider: string; status: string; connected: boolean }): { label: string; canConnect: boolean; canSwitchToUazapi: boolean; canSwitchToEvolution: boolean; polling: boolean }`.
  - Textos: `not_created` → "Ainda não conectada"; `connecting` → "Aguardando leitura do QR Code"; `connected` → "Conectada"; outros → "Desconectada".
  - `canSwitchToUazapi` só com `connected && provider === "evolution"`; `canSwitchToEvolution` com `provider === "uazapi"`; `polling` com `status === "connecting"` (consulta o estado a cada 5 s).
- Tela: campo opcional "Celular (para código de pareamento)", botão "Conectar UAZAPI", imagem do `qrcode` (data URI) ou o `paircode` em destaque, rótulo do estado, provedor atual ("Em uso: Evolution" / "Em uso: UAZAPI"), botões "Usar UAZAPI" e "Voltar para Evolution" com confirmação pelo componente `Dialog` existente (nunca `window.confirm`). Nenhum botão de apagar instância.

- [ ] **Step 1: Teste** de `describeUazapiPanel` com as combinações acima (5 casos: não criada, conectando, conectada em evolution, conectada em uazapi, desconectada em uazapi → `canSwitchToEvolution true`, `canSwitchToUazapi false`).
- [ ] **Step 2:** Rodar `--filter=@aula-agente/web -- uazapi-panel` → FALHA.
- [ ] **Step 3:** Implementar o estado e o componente; ligar na página.
- [ ] **Step 4:** Teste PASSA e `pnpm turbo build --filter=@aula-agente/web` compila.
- [ ] **Step 5:** Commit `feat(web): painel para conectar e virar a instância para a UAZAPI`.

### Task 8: Verificação final e PR

- [ ] **Step 1:** `pnpm turbo test --concurrency=1` e `pnpm turbo build` na raiz → tudo verde.
- [ ] **Step 2:** `git grep -n "UAZAPI_ADMIN_TOKEN" -- apps packages` só aparece em leitura de `process.env` (nunca em log ou resposta).
- [ ] **Step 3:** Abrir o PR para `main` com: o que muda; migração `20261120140000_whatsapp_provider.sql` (aplicar no SQL Editor com autorização; o código funciona antes dela); variáveis a colar no EasyPanel pelo dono (`UAZAPI_BASE_URL=https://motoetrilha.uazapi.com` e `UAZAPI_ADMIN_TOKEN` em api e worker; `API_PUBLIC_URL` na api); o roteiro de virada abaixo; rollback = `PUT /provider evolution` (ou `update evolution_instances set provider='evolution'`).

## Roteiro de virada (depois do merge autorizado)

1. Dono cola as variáveis no EasyPanel (api e worker) e reinicia os dois serviços.
2. Eu aplico a migração no SQL Editor (com autorização) e confiro as colunas.
3. Dono abre a instância no CRM, toca "Conectar UAZAPI" e lê o QR com o celular da loja (Aparelhos conectados → Conectar aparelho). A Evolution continua conectada.
4. Estado "Conectada" → "Usar UAZAPI".
5. Conferência (spec, "Virada direta" item 2): texto, áudio, imagem e documento do celular do dono; clique num anúncio; resposta da IA uma vez; eco do celular da loja; ✓✓. Eu confiro no banco e nos logs de forma.
6. Problema grave → "Voltar para Evolution".
