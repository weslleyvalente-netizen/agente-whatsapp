# Conversas no estilo WhatsApp Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar a aba Conversas parecida com o WhatsApp Web (foto do cliente), receber imagem/vídeo/documento do cliente e permitir que a atendente envie esses anexos.

**Architecture:** Três etapas, cada uma um PR próprio (Etapa 1 = Tasks 1-7, Etapa 2 = Tasks 8-12, Etapa 3 = Tasks 13-16). Segue o padrão já existente do áudio do cliente: referência `storage:<bucket>/<caminho>` em `messages.media_url`, job BullMQ no worker, bucket privado, link assinado emitido pela API depois de `canViewLead`, retenção diária. Layout novo e envio de anexos ficam atrás de flags em `organizations.settings` (sem migração).

**Tech Stack:** TypeScript monorepo (pnpm): Fastify API, Next.js web, BullMQ worker, Supabase (Postgres + Storage), vitest, Evolution API 2.3.7.

**Spec:** `docs/superpowers/specs/2026-11-08-conversas-estilo-whatsapp-design.md`

## Global Constraints

- Cada etapa é um PR separado, criado a partir do `origin/main` atualizado; merge só com ok explícito do dono. Migração de produção é colada pelo dono no SQL editor do Supabase (nunca aplicada por nós).
- Buckets privados; nada público. Link assinado: 300 s para mídia do chat, 3600 s para foto de perfil.
- Limites: imagem ≤ 16 MB, vídeo ≤ 16 MB, documento ≤ 25 MB. Retenção da mídia do chat: 30 dias. Foto de perfil: atualizar se tiver mais de 7 dias; sem foto, tentar de novo após 24 h.
- Falha de mídia ou foto nunca derruba o webhook (enfileirar é best-effort, como `enqueueStoreCustomerAudio`) nem impede salvar o texto da mensagem.
- Contato ignorado `no_store` nunca tem arquivo guardado (o webhook já retorna antes; manter o enqueue depois desse ponto).
- Com a flag `inbox_whatsapp_layout_enabled` desligada, nada visual muda. Anexos só com `seller_attachments_enabled === true`.
- Mensagens antigas não são recuperadas. Sem `any` novo; português nas mensagens ao usuário; estilo do repo (ver `apps/worker/src/lib/customer-audio.ts`, `apps/api/src/routes/messages/audio-url.ts`).
- Comandos de verificação (rodar na raiz do worktree): `pnpm --filter @aula-agente/<pkg> test` e `pnpm --filter @aula-agente/<pkg> build` para `shared`, `database`, `queue`, `api`, `worker`, `web` conforme o que a task tocar.

## Rulings (decididos aqui; custo se errado entre parênteses)

- **Upload de anexo pela API (multipart), não direto ao Storage.** O spec dizia "URL assinada de upload"; o padrão do áudio (`send-audio.ts`) já valida o arquivo por bytes antes de guardar e não deixa arquivo órfão. O spec deve ser ajustado para isso (custo: API segura até 25 MB em memória por envio; limitado a 60 envios/hora/usuário).
- **Flag própria `seller_attachments_enabled`** para o envio (o spec só citava a flag do layout). Receber mídia não tem flag. (Custo: um interruptor a mais em Configurações.)
- **Ticks:** não há dados de entrega/leitura. Um ✓ quando a mensagem tem `evolution_message_id`; vermelho "não enviado" quando há `send_failed_at`. Sem ✓✓.
- **Contador de não lidas:** o dado é só um booleano `unread`; vira bolinha verde, não número.

## Review Focus

1. Vendedor pedindo link de mídia ou foto de lead de outro vendedor → 403 (Tasks 4 e 11).
2. Evolution devolvendo mídia vazia, acima do limite ou erro → mensagem preservada, `metadata.media.status` marcado, sem laço de retentativas (Task 9).
3. Webhook repetido para a mesma mensagem → um único job (`jobId = messageId`) e job idempotente (Tasks 9 e 10).
4. Contato com telefone `@lid`/não numérico ou grupo → nunca dispara busca de foto (Tasks 1 e 3).
5. Anexo com extensão trocada, bytes que não batem, vazio ou grande demais → rejeitado e a vaga do limite devolvida (Tasks 13 e 14).
6. `media_url` forjada por membro (RLS permite editar) → nunca assina nem apaga caminho que não é da própria linha (Tasks 9 e 11).
7. Flag do layout desligada → nenhuma classe/estrutura nova no DOM (Task 7, verificação manual).

---

## ETAPA 1 — Layout WhatsApp Web e foto de perfil

### Task 1: Migração, tipos e utilitários de foto

**Files:**
- Create: `supabase/migrations/20261108120000_chat_media_and_profile_pictures.sql`
- Create: `packages/shared/src/profile-picture.ts`, `packages/shared/src/profile-picture.test.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/types/contact.ts`, `packages/shared/src/types/organization.ts`

**Interfaces:**
- Produces (`@aula-agente/shared`): `PROFILE_PICTURE_BUCKET = "profile-pictures"`; `PROFILE_PICTURE_REFRESH_DAYS = 7`; `PROFILE_PICTURE_RETRY_HOURS = 24`; `PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS = 3600`; `buildProfilePicturePath(p: {organizationId: string; contactId: string; extension: "jpg"|"png"|"webp"}): string` → `<org>/<contact>.<ext>`; `shouldRefreshProfilePicture(c: {phone: string; profile_picture_path: string | null; profile_picture_checked_at: string | null}, now?: Date): boolean`; `contactInitials(name: string | null, phone: string): string`; `avatarColorIndex(seed: string, paletteSize: number): number`.
- `Contact` ganha `profile_picture_path: string | null; profile_picture_checked_at: string | null`. `OrganizationSettings` ganha `inbox_whatsapp_layout_enabled?: boolean; seller_attachments_enabled?: boolean`.

- [ ] **Step 1: Escrever `profile-picture.test.ts` (falha).** Casos: `shouldRefreshProfilePicture` → `false` para telefone `"109435900932124@lid"` e `"12"`; `true` com `checked_at` nulo; com foto e `checked_at` de 6 dias → `false`, de 8 dias → `true`; sem foto e `checked_at` de 23 h → `false`, de 25 h → `true`. `contactInitials("Maria da Silva","5562999990000")` → `"MS"`; `("joão",…)` → `"J"`; `(null,"5562999990000")` → `"#"`. `avatarColorIndex("abc",8)` é estável entre chamadas e fica em `[0,8)`. `buildProfilePicturePath` → `"org/contact.jpg"`.
- [ ] **Step 2:** Rodar `pnpm --filter @aula-agente/shared test -- profile-picture` → FAIL (módulo inexistente).
- [ ] **Step 3: Implementar `profile-picture.ts` e os tipos** conforme Interfaces. Telefone válido = `/^\d{8,15}$/`. Iniciais: até 2 primeiras letras das duas primeiras palavras, maiúsculas.
- [ ] **Step 4: Escrever a migração SQL** (idempotente, com comentário explicando que é colada pelo dono): `alter table wa_contacts add column if not exists profile_picture_path text, add column if not exists profile_picture_checked_at timestamptz;` buckets privados via `insert into storage.buckets ... on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit` para `profile-pictures` (2097152 bytes, mime `image/jpeg,image/png,image/webp`) e `chat-media` (26214400 bytes, sem restrição de mime — o servidor força `download` para documentos); índice parcial `idx_messages_chat_media_created_at on messages (created_at) where media_url like 'storage:chat-media/%'`. Sem policies para anon/authenticated (mesmo padrão de `20261016120000_customer_audio_bucket.sql`).
- [ ] **Step 5:** Rodar teste e `pnpm --filter @aula-agente/shared build` → PASS. **Commit:** `feat(shared): migração e utilitários de foto de perfil`.

### Task 2: Fila e worker `fetch-profile-picture`

**Files:**
- Modify: `packages/shared/src/constants.ts` (`QUEUE_NAMES.FETCH_PROFILE_PICTURE = "fetch-profile-picture"`), `packages/queue/src/types.ts`, `packages/queue/src/queues.ts`, `packages/queue/src/index.ts`, `packages/database/src/queries/contacts.ts` (ou onde ficam as queries de `wa_contacts`; exportar no índice), `apps/api/src/lib/queue.ts`, `apps/worker/src/index.ts`
- Create: `apps/worker/src/lib/profile-picture.ts`, `apps/worker/src/lib/profile-picture.test.ts`, `apps/worker/src/workers/fetch-profile-picture.ts`

**Interfaces:**
- Produces: `FetchProfilePictureJobData = {contactId: string; organizationId: string; instanceId: string; phone: string}` (em `@aula-agente/queue`); `getFetchProfilePictureQueue()` com `attempts: 2`, backoff exponencial 5 s, `removeOnComplete: true`, `removeOnFail: true` (libera o `jobId` para a próxima tentativa); `enqueueFetchProfilePicture(data: FetchProfilePictureJobData)` em `apps/api/src/lib/queue.ts` com `jobId = data.contactId`; `setContactProfilePicture(client, contactId: string, path: string | null): Promise<void>` (sempre grava `profile_picture_checked_at = now()`; só troca `profile_picture_path` quando `path` não é nulo).
- Worker lib: `fetchContactProfilePicture(db, input: FetchProfilePictureJobData, deps?: {fetchPictureUrl?: (instanceName: string, phone: string) => Promise<string | null>; downloadImage?: (url: string) => Promise<{buffer: Buffer; contentType: string} | null>}): Promise<{ok: true; stored: boolean} | {ok: false; reason: string}>`.

- [ ] **Step 1: Teste (falha)** `profile-picture.test.ts` com `deps` falsos e `db` falso: (a) URL nula (foto oculta) → `{ok:true, stored:false}` e `setContactProfilePicture(…, null)` chamado (marca a tentativa); (b) URL válida + imagem `image/jpeg` → upload em `profile-pictures` no caminho `buildProfilePicturePath(...)` com `upsert: true` e `setContactProfilePicture(…, path)`; (c) imagem > 2 MB ou `contentType` não-imagem → `stored:false` sem upload; (d) `fetchPictureUrl` lança → `{ok:false}` (BullMQ tenta de novo) e a tentativa é marcada mesmo assim (`setContactProfilePicture(…, null)`), para o webhook não reenfileirar a cada mensagem.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3: Implementar** a lib: instância via `getInstanceById(db, instanceId)`; `fetchPictureUrl` default = `POST ${EVOLUTION_API_URL}/chat/fetchProfilePictureUrl/${instanceName}` com `{number: phone}` e `apikey`, timeout 10 s, lê `profilePictureUrl` (nulo/ausente → `null`) — **conferir o formato contra a Evolution 2.3.7 em produção por leitura (`GET`/`POST` de teste só de leitura, com autorização do dono) antes de dar a task como pronta**; `downloadImage` default = `fetch` com timeout 10 s, aceita só `image/jpeg|png|webp`, máx. 2 MB; extensão derivada do content-type. Worker `fetch-profile-picture.ts` no padrão de `store-customer-audio.ts` (concurrency 2; lança `Error` quando `ok:false`). Registrar em `apps/worker/src/index.ts`.
- [ ] **Step 4:** Rodar testes e builds de `shared`, `queue`, `database`, `api`, `worker` → PASS. **Commit:** `feat(worker): busca e guarda foto de perfil do contato`.

### Task 3: Webhook enfileira a busca da foto

**Files:**
- Modify: `apps/api/src/routes/webhooks/evolution.ts` (logo depois do bloco `mediaType === "audio"` que enfileira `enqueueStoreCustomerAudio`, ~linha 511), teste em `apps/api/src/routes/webhooks/evolution-lid.test.ts` ou novo `evolution-profile-picture.test.ts` (seguir o arquivo de teste de webhook mais próximo)

**Interfaces:**
- Consumes: `shouldRefreshProfilePicture`, `enqueueFetchProfilePicture` (Tasks 1-2). O `contact` já vem de `wa_contacts` completo no webhook (conferir que o `select` inclui as duas colunas novas; se for lista explícita, incluí-las).

- [ ] **Step 1: Testes (falham):** mensagem de contato novo com telefone numérico → `enqueueFetchProfilePicture` chamado com `{contactId, organizationId, instanceId, phone}`; contato com `profile_picture_checked_at` de 1 h atrás → não chama; telefone `…@lid` → não chama; contato ignorado → não chama; `enqueueFetchProfilePicture` rejeitando → webhook ainda responde 200 e salva a mensagem.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar (try/catch com `request.log.error`, igual ao áudio; só para mensagens `role === "contact"`). **Step 4:** `pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/api build` → PASS. **Commit:** `feat(api): webhook agenda busca da foto de perfil`.

### Task 4: API de links das fotos

**Files:**
- Create: `apps/api/src/routes/contacts/profile-picture-urls.ts`, `apps/api/src/routes/contacts/profile-picture-urls.test.ts`
- Modify: `apps/api/src/server.ts` (registrar a rota, como `messageAudioUrlRoutes`)

**Interfaces:**
- Produces: `POST /contacts/profile-picture-urls` com body `{contact_ids: string[]}` (uuid, 1 a 100) → `{urls: Record<string, string>}`; contatos sem foto, de outra organização ou de lead que o usuário não pode ver simplesmente não aparecem em `urls`. Auth: `authMiddleware`. Permissão: membro da organização do contato **e** (`canViewLead` verdadeiro para alguma conversa do contato, ou o contato não tem conversa).

- [ ] **Step 1: Testes (falham)** no estilo de `audio-url.test.ts`: body inválido → 400; mais de 100 ids → 400; contato de organização da qual o usuário não é membro → ausente em `urls`; vendedor com isolamento ligado pedindo contato cuja conversa é de outro vendedor → ausente; contato permitido com `profile_picture_path` → `urls[id]` vem de `createSignedUrl(path, 3600)`; erro ao assinar → ausente (200 mesmo assim).
- [ ] **Step 2:** FAIL. **Step 3:** Implementar (uma query dos contatos, uma das conversas por `contact_id in (...)`, `canViewLead` por conversa; assinar com `createSignedUrls` em lote se disponível). **Step 4:** testes + build api → PASS. **Commit:** `feat(api): links assinados das fotos de perfil`.

### Task 5: Avatar com foto no web

**Files:**
- Create: `apps/web/src/lib/profile-pictures.ts`, `apps/web/src/lib/profile-pictures.test.ts`, `apps/web/src/components/inbox/contact-avatar.tsx`
- Modify: `apps/web/src/components/inbox/conversation-list.tsx`, `apps/web/src/components/inbox/chat-header.tsx`, `apps/web/src/app/(dashboard)/inbox/page.tsx` e o `select` de `chat-panel.tsx` (`wa_contacts(id, phone, name, ai_disabled, profile_picture_path)`; na lista, `ConversationItem.wa_contacts` ganha `id` e `profile_picture_path`)

**Interfaces:**
- Produces: `createProfilePictureResolver(fetchBatch: (ids: string[]) => Promise<Record<string, string>>, opts?: {now?: () => number; ttlMs?: number; batchDelayMs?: number}): {request(contactId: string): Promise<string | null>}` — junta pedidos feitos dentro de `batchDelayMs` (padrão 40 ms) em uma chamada, cache por `ttlMs` (padrão 50 min), não repete id em voo, ids ausentes na resposta viram `null` (também em cache); `useProfilePictureUrl(contactId: string | undefined, picturePath: string | null): string | null`; `<ContactAvatar contactId name phone picturePath className? />` usando `@/components/ui/avatar`: imagem quando há URL; senão círculo com `contactInitials` e cor de uma paleta fixa via `avatarColorIndex(contactId, N)`. O resolver global usa `apiFetch("/contacts/profile-picture-urls", {method:"POST", body})`.

- [ ] **Step 1: Testes (falham)** do resolver com fetch falso e relógio falso: três `request` no mesmo tick → 1 chamada com 3 ids; segundo `request` do mesmo id dentro do TTL → sem nova chamada; após o TTL → nova chamada; id ausente na resposta → `null`; `fetchBatch` lançando → todos `null` e sem cache (tenta de novo depois).
- [ ] **Step 2:** `pnpm --filter @aula-agente/web test -- profile-pictures` → FAIL. **Step 3:** Implementar. **Step 4:** Trocar os `Avatar` atuais da lista e do cabeçalho por `ContactAvatar` (sem mudar nada além do avatar); testes + `pnpm --filter @aula-agente/web build` → PASS. **Step 5: Verificação visual** com `preview_start` (contato sem foto mostra iniciais coloridas; lista continua carregando rápido). **Commit:** `feat(web): avatar com foto de perfil e iniciais`.

### Task 6: Flag do layout e interruptor em Configurações

**Files:**
- Modify: `apps/web/src/app/(dashboard)/settings/page.tsx` (adicionar `"inbox_whatsapp_layout_enabled"` à união de flags de `toggleWorkspace`, ao conjunto `isLead`, e um `Switch` para gerente ao lado do de áudio, com texto: "Layout das Conversas igual ao WhatsApp Web. Pode ser desligado a qualquer momento.")
- Create: `apps/web/src/hooks/use-whatsapp-layout.ts`

**Interfaces:**
- Produces: `useWhatsappLayout(): boolean` → `useOrganization().currentOrg?.settings.inbox_whatsapp_layout_enabled === true`.

- [ ] **Step 1:** Implementar o hook e o interruptor (não há teste automático de componente neste repo; o hook é uma linha sobre o provider). **Step 2:** `pnpm --filter @aula-agente/web build` → PASS. **Step 3: Verificação manual** no preview: ligar/desligar persiste em `organizations.settings` sem perder outras chaves. **Commit:** `feat(web): flag do layout WhatsApp nas configurações`.

### Task 7: Reskin das Conversas atrás da flag

**Files:**
- Create: `apps/web/src/lib/whatsapp-layout.ts`, `apps/web/src/lib/whatsapp-layout.test.ts`, `apps/web/src/components/inbox/message-composer.tsx`
- Modify: `apps/web/src/components/inbox/{conversation-list,chat-header,message-bubble,chat-panel}.tsx`, `apps/web/src/app/(dashboard)/inbox/page.tsx` (painéis)

**Interfaces:**
- Produces: `messageTick(m: {role: string; evolution_message_id: string | null; metadata: {send_failed_at?: string} | null}): "sent" | "failed" | null` (só para `agent`/`human_agent`); `WA_THEME` com as classes Tailwind do tema (fundo do chat `#efeae2`, balão recebido branco, enviado `#d9fdd3`, cabeçalho `#f0f2f5`, destaque `#00a884`; variantes escuras via `dark:`); `<MessageComposer value onChange onSend sending disabled placeholder extraActions? />` — `textarea` multilinha que cresce até 6 linhas, Enter envia, Shift+Enter quebra linha, botão enviar.

- [ ] **Step 1: Testes (falham)** de `messageTick`: `human_agent` com `evolution_message_id` → `"sent"`; sem id e sem falha → `null`; com `send_failed_at` → `"failed"`; `contact` → `null`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar `whatsapp-layout.ts`. **Step 4:** Aplicar o layout **só quando `useWhatsappLayout()` for true**; com false, renderizar exatamente a estrutura atual (preferir ramificar por classe/prop, sem duplicar lógica): lista com avatar maior, nome, prévia, hora e bolinha verde de não lida; cabeçalho compacto com avatar e status; balões com cantos e "rabinho", hora e ✓ dentro do balão, separador de dia como pílula (já existe); fundo bege; composer `MessageComposer` no lugar do `Input` (o `draft` externo continua só preenchendo o campo; a regra atual de achatar quebras de linha do rascunho permanece). O botão de áudio continua em `extraActions`.
- [ ] **Step 5:** testes + build web → PASS. **Step 6: Verificação visual** no preview com a flag ligada e desligada (screenshots); conferir 1366×768 e 1920×1080. **Commit:** `feat(web): layout das Conversas estilo WhatsApp Web (flag)`.

**→ Fim da Etapa 1: abrir PR, revisão independente, ok do dono, dono cola a migração, merge.**

---

## ETAPA 2 — Receber imagem, vídeo e documento

### Task 8: Módulo compartilhado de mídia do chat e utilitários

**Files:**
- Create: `packages/shared/src/chat-media.ts`, `packages/shared/src/chat-media.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/types/message.ts`, `packages/database/src/queries/messages.ts` (+ export), `packages/agent-runtime/src/audio-transcription.ts` (ou arquivo vizinho) + export

**Interfaces:**
- Produces: `CHAT_MEDIA_BUCKET = "chat-media"`; `CHAT_MEDIA_REF_PREFIX = "storage:chat-media/"`; `CHAT_MEDIA_RETENTION_DAYS = 30`; `CHAT_MEDIA_SIGNED_URL_TTL_SECONDS = 300`; `CHAT_MEDIA_MAX_BYTES: Record<"image"|"video"|"document", number>` (16 MB, 16 MB, 25 MB); `buildChatMediaRef(p: {organizationId; conversationId; messageId; extension}): string`; `parseChatMediaRef(ref: string | null | undefined): {bucket: string; path: string} | null` (rejeita `..` e partes vazias); `isChatMediaRefFor(ref, ids: {organizationId; conversationId; messageId}): boolean` (extensão `[a-z0-9]{1,8}`, caminho exato da própria mensagem); `extensionFromMime(mime: string, fileName?: string): string`.
- `MessageMetadata` ganha `source` com `"seller_attachment"` e `media?: {status: "stored" | "too_large" | "failed"; file_name?: string; mime_type?: string; size_bytes?: number}`.
- `mergeMessageMetadata(client, id: string, patch: Partial<MessageMetadata>): Promise<void>` (lê, mescla `media` por cima, grava).
- `fetchMediaBase64(instanceName: string, evolutionMessageId: string, timeoutMs?: number): Promise<{base64: string; mimetype: string; fileName?: string}>` — `POST /chat/getBase64FromMediaMessage/{instance}` **sem** `convertToMp4`, timeout padrão 60 s.

- [ ] **Step 1: Testes (falham)** do `chat-media.test.ts`: round-trip `build`/`parse`; `parse` rejeita `storage:chat-media/../x`, `storage:customer-audio/x`, vazio; `isChatMediaRefFor` aceita o caminho exato e rejeita outra mensagem/organização e `.mp4/../`; `extensionFromMime("application/pdf")` → `"pdf"`, `("video/mp4")` → `"mp4"`, `("application/octet-stream","a.docx")` → `"docx"`, desconhecido sem nome → `"bin"`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar tudo acima. **Step 4:** testes e builds `shared`, `database`, `agent-runtime` → PASS. **Commit:** `feat(shared): referências e limites da mídia do chat`.

### Task 9: Worker `store-chat-media` e retenção

**Files:**
- Modify: `packages/shared/src/constants.ts` (`STORE_CHAT_MEDIA: "store-chat-media"`, `CHAT_MEDIA_RETENTION: "chat-media-retention"`), `packages/queue/src/{types,queues,index}.ts`, `apps/api/src/lib/queue.ts`, `apps/worker/src/index.ts`
- Create: `apps/worker/src/lib/chat-media.ts`, `apps/worker/src/lib/chat-media.test.ts`, `apps/worker/src/workers/store-chat-media.ts`

**Interfaces:**
- Produces: `StoreChatMediaJobData = {messageId; conversationId; organizationId}`; `enqueueStoreChatMedia(data, opts?: {retry?: boolean})` com `jobId = messageId` (ou `${messageId}-retry-${Date.now()}` quando `retry`), fila com `attempts: 4`, backoff exponencial 5 s; `storeChatMedia(db, input, fetchMedia = fetchMediaBase64-com-instância): Promise<{ok:true; mediaUrl: string} | {ok:true; skipped: "already_stored"|"not_chat_media"|"too_large"} | {ok:false; reason: string; permanent?: boolean}>`; `runChatMediaRetention(db, now?: Date): Promise<{deleted: number}>`.

- [ ] **Step 1: Testes (falham)** em `chat-media.test.ts` (db e fetch falsos, no estilo de `customer-audio.test.ts`): (a) imagem de contato → upload em `chat-media` no caminho de `buildChatMediaRef`, `media_url` gravada via `setMessageMediaUrlIfEmpty`, `metadata.media = {status:"stored", mime_type, size_bytes, file_name}`; (b) arquivo acima do limite do tipo → `skipped:"too_large"`, `metadata.media.status="too_large"`, sem upload; (c) base64 vazio → `ok:false, permanent:true` e `status:"failed"`; (d) mensagem já com `media_url` → `already_stored`; (e) `role` ≠ contact ou `media_type` fora de image/video/document → `not_chat_media`; (f) upload `409` → trata como sucesso; (g) retenção: apaga só caminhos que passam em `isChatMediaRefFor` da própria linha, zera `media_url` de todas as linhas do lote e preserva `metadata.media`; referência forjada só tem `media_url` zerado, sem `remove`.
- [ ] **Step 2:** FAIL. **Step 3: Implementar** espelhando `apps/worker/src/lib/customer-audio.ts`: `file_name` vem de `fileName` do Evolution ou do `content` quando for documento; `contentType` do Evolution (fallback por tipo). Worker: erro permanente → `UnrecoverableError`; no evento `failed` final → `mergeMessageMetadata(…, {media:{status:"failed"}})`. Retenção diária no mesmo molde de `startCustomerAudioRetentionWorker`, usando `listExpiredStoredAudioMessages(db, CHAT_MEDIA_REF_PREFIX, cutoff)` e `clearMessageMediaUrls`. Registrar os dois em `apps/worker/src/index.ts`.
- [ ] **Step 4:** testes e builds `shared`, `queue`, `api`, `worker` → PASS. **Commit:** `feat(worker): guarda mídia recebida do cliente e retenção de 30 dias`.

### Task 10: Webhook enfileira a captura de mídia

**Files:** Modify `apps/api/src/routes/webhooks/evolution.ts` (ao lado do bloco de áudio) e o arquivo de teste de webhook usado na Task 3.

- [ ] **Step 1: Testes (falham):** mensagem de contato `imageMessage`, `videoMessage` e `documentMessage` → `enqueueStoreChatMedia` com `{messageId, conversationId, organizationId}`; texto → não chama; contato `no_store`/ignorado mínimo → não chama; fila rejeitando → 200 e mensagem salva; mesma mensagem entregue duas vezes → segunda é descartada pela dedupe existente (nenhum enqueue extra).
- [ ] **Step 2:** FAIL. **Step 3:** Implementar (best-effort com `request.log.error`). **Step 4:** testes + build api → PASS. **Commit:** `feat(api): webhook agenda captura da mídia do cliente`.

### Task 11: Rotas `media-url` e `retry-media`

**Files:**
- Create: `apps/api/src/routes/messages/media-url.ts`, `apps/api/src/routes/messages/media-url.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Produces: `GET /messages/:messageId/media-url?download=1` → `{url, expiresIn, fileName: string | null, mimeType: string | null}`; `POST /messages/:messageId/retry-media` → `{ok: true}`.
- Regras (copiar a ordem de `audio-url.ts`): 400 id inválido; 404 mensagem; 403 sem vínculo com a organização; `role` em `contact|human_agent` e `media_type` em `image|video|document`, senão 404; conversa da mesma organização; `canViewLead` senão 403; só assina se `isChatMediaRefFor(message.media_url, ids)` (senão 404). `download=1` ou `media_type === "document"` → `createSignedUrl(path, 300, {download: fileName ?? true})`. `retry-media`: só para `contact` com `metadata.media.status === "failed"` e `media_url` nulo (senão 409); enfileira com `{retry: true}` e zera o status para ausente.

- [ ] **Step 1: Testes (falham):** 403 vendedor de outro lead; 404 `media_url` forjada (`storage:chat-media/outra-org/...`); 404 sem `media_url`; documento assina com `download`; imagem assina sem `download`; `retry-media` com status `stored` → 409; com `failed` → enfileira uma vez.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** testes + build api → PASS. **Commit:** `feat(api): links e nova tentativa da mídia do chat`.

### Task 12: Bolhas com imagem, vídeo e documento

**Files:**
- Create: `apps/web/src/lib/chat-media.ts`, `apps/web/src/lib/chat-media.test.ts`, `apps/web/src/components/inbox/chat-media.tsx`
- Modify: `apps/web/src/components/inbox/message-bubble.tsx`

**Interfaces:**
- Produces: `chatMediaState(m: {media_type: string | null; media_url: string | null; metadata: {media?: {status?: string}} | null; created_at: string}, now?: Date): "stored" | "expired" | "too_large" | "failed" | "pending" | "none"` — `stored` = `media_url` começa com `storage:chat-media/`; `expired` = `media_url` nulo, `media.status === "stored"`; `too_large`/`failed` vêm do status; `pending` = `media_url` nulo, sem status e mensagem com menos de 10 min; `none` caso contrário (mensagens antigas: segue só texto como hoje); `formatBytes(n: number): string` ("1,2 MB"); `<ChatMedia message />` que pede `/messages/:id/media-url` ao montar (imagem: miniatura com `max-h-72`, clique abre ampliada num `Dialog`; vídeo: `<video controls preload="metadata">` carregando o link só ao clicar em "Reproduzir"; documento: cartão com ícone, `metadata.media.file_name`, tamanho e botão "Baixar" que pede `?download=1`); link vencido → renova uma vez (padrão do `customer-audio-player.tsx`); `too_large` → "Arquivo grande, abra no celular da loja"; `failed` → "Não foi possível baixar" + botão "Tentar de novo" (`POST …/retry-media`); `expired` → "Arquivo expirado".
- A ramificação atual `message.media_type === "image" && message.media_url` com `<img src>` continua valendo quando `media_url` **não** começa com `storage:` (imagens enviadas pela IA no bucket público).

- [ ] **Step 1: Testes (falham)** de `chatMediaState` (todos os estados acima, incluindo mensagem antiga sem status → `none`) e `formatBytes`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar e integrar na bolha (acima do texto/legenda; legenda e `[imagem]` continuam como estão; esconder o texto quando for só o placeholder `[imagem]`/`[video]` e a mídia estiver `stored`). **Step 4:** testes + build web → PASS. **Step 5: Verificação visual** no preview com mensagens de teste. **Commit:** `feat(web): exibe imagem, vídeo e documento do cliente`.

**→ Fim da Etapa 2: PR, revisão, ok do dono, merge. Teste real pelo dono: mandar imagem, PDF e vídeo do celular para o número da loja.**

---

## ETAPA 3 — Enviar anexos

### Task 13: Validação de anexo por bytes

**Files:** Create `packages/shared/src/attachment.ts`, `packages/shared/src/attachment.test.ts`; Modify `packages/shared/src/index.ts`.

**Interfaces:**
- Produces: `ATTACHMENT_LIMIT_PER_HOUR = 60`; `detectAttachmentFormat(buffer: Uint8Array, fileName: string): {kind: "image" | "video" | "document"; mime: string; extension: string} | null`. Imagem: JPEG (`FF D8 FF`), PNG, WebP (`RIFF…WEBP`). Vídeo: caixa `ftyp` no offset 4 (marca `qt  ` → `video/quicktime`/`mov`; demais → `video/mp4`/`mp4`). Documento: `%PDF`; zip (`PK\x03\x04`) só com extensão `docx|xlsx|pptx`; OLE (`D0 CF 11 E0`) só com `doc|xls|ppt`; texto sem byte NUL nos primeiros 8 KB só com extensão `txt|csv`. Qualquer divergência extensão × bytes → `null`.

- [ ] **Step 1: Testes (falham):** um buffer mínimo válido por formato; PNG renomeado `.pdf` → `null`; `.exe`/`MZ` → `null`; zip com `.docx` ok e com `.pdf` → `null`; buffer vazio → `null`; texto com NUL com `.txt` → `null`; extensão em maiúsculas (`FOTO.JPG`) aceita.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** testes + build shared → PASS. **Commit:** `feat(shared): detecção de formato de anexo por bytes`.

### Task 14: Rota `send-attachment` e `sendPanelMessage`

**Files:**
- Create: `apps/api/src/routes/messages/send-attachment.ts`, `…/send-attachment.test.ts`, `…/send-attachment-limit.ts`
- Modify: `apps/api/src/services/message-send.service.ts` (+ teste), `apps/api/src/server.ts`, `packages/queue/src/types.ts` (`SendMessageJobData` ganha `storedMediaRef?: string; mediaFileName?: string; mediaMime?: string; mediaKind?: "image"|"video"|"document"`)

**Interfaces:**
- Produces: `POST /messages/send-attachment` (multipart; campos `conversation_id` e `caption` (opcional, ≤ 1000) **antes** do arquivo `file`) → `{ok: true, messageId}`; limiter `takeAttachmentSlot/releaseAttachmentSlot/resetAttachmentLimitForTests` no formato de `send-audio-limit.ts`, chave `${organizationId}:${userId}`, 60/h.
- `SendPanelMessageParams.attachment?: {buffer: Buffer; kind: "image"|"video"|"document"; mime: string; extension: string; fileName: string; caption?: string}`; `class SellerAttachmentSendError extends Error {uploaded: boolean}`. Com `attachment`: `content = caption ?? ("[imagem]" | "[video]" | fileName)`, `media_type = kind`, `metadata = {source: "seller_attachment", media: {status:"stored", file_name, mime_type, size_bytes}}`, upload em `chat-media` no `buildChatMediaRef` + `setMessageMediaUrlIfEmpty`, job com `storedMediaRef/mediaFileName/mediaMime/mediaKind` e `{attempts: 1}`; qualquer falha após salvar a linha marca `send_failed_at` e lança `SellerAttachmentSendError` (mesmo desenho do bloco de áudio).
- Ordem de validações na rota (como `send-audio.ts`): arquivo presente → conversa → membro → `settings.seller_attachments_enabled === true` (senão 404) → `canViewLead` → vaga do limite → `toBuffer` com `limits.fileSize = 25 MB` (413 "Arquivo acima do limite") → `detectAttachmentFormat` (400 "Tipo de arquivo não suportado.") → tamanho vs `CHAT_MEDIA_MAX_BYTES[kind]` (413 com o limite do tipo) → `sendPanelMessage`.

- [ ] **Step 1: Testes (falham)** na rota: flag desligada → 404; lead de outro vendedor → 403; PNG com nome `.pdf` → 400 e vaga devolvida; arquivo vazio → 400 e vaga devolvida; vídeo de 17 MB → 413; 61º envio na hora → 429; JPEG válido com legenda → 200 e `sendPanelMessage` chamado com `attachment.kind === "image"`. No serviço: caminho do upload correto; falha no upload → `send_failed_at` gravado e `SellerAttachmentSendError{uploaded:false}`; falha ao enfileirar depois do upload → `uploaded:true`; takeover/handoff idêntico ao envio de texto.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar (registrar `@fastify/multipart` no plugin, como `send-audio.ts`). **Step 4:** testes + build `shared`, `queue`, `api` → PASS. **Commit:** `feat(api): envio de anexos pelo painel`.

### Task 15: Worker envia mídia armazenada

**Files:** Modify `apps/worker/src/workers/send-message.ts`, `apps/worker/src/workers/send-message.test.ts`.

**Interfaces:**
- `sendEvolutionMedia(instanceName, phone, mediaUrl, caption, opts?: {mediatype?: "image"|"video"|"document"; fileName?: string; mimetype?: string})` — padrão `image` mantém os chamadores atuais intactos; com `document` envia `fileName`; com `mimetype` quando informado.

- [ ] **Step 1: Testes (falham):** job com `storedMediaRef` → baixa/assina `createSignedUrl(path, 300)` do `chat-media`, chama `/message/sendMedia/…` com `mediatype`, `media` (URL assinada), `fileName` e `caption`; `evolution_message_id` é gravado de volta; falha de assinatura ou do Evolution → `send_failed_at` marcado (reutilizar `markSellerAudioFailed`) e o job falha **sem** fallback para texto; `storedMediaRef` inválido (`parseChatMediaRef` nulo) → falha marcada; fluxo de imagem da IA com `mediaUrl` continua igual.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar o ramo `storedMediaRef` ao lado do `storedAudioRef`. **Step 4:** testes + build worker → PASS. **Commit:** `feat(worker): envia anexo guardado pelo Evolution`.

### Task 16: Clipe, pré-visualização e arrastar-e-soltar

**Files:**
- Create: `apps/web/src/lib/attachment-picker.ts`, `apps/web/src/lib/attachment-picker.test.ts`, `apps/web/src/components/inbox/attachment-composer.tsx`
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`, `apps/web/src/components/inbox/message-bubble.tsx`, `apps/web/src/app/(dashboard)/settings/page.tsx` (flag `seller_attachments_enabled`, mesmo padrão da Task 6; texto: "Atendente pode enviar imagem, vídeo e documento no chat. Limites: imagem e vídeo 16 MB, documento 25 MB, 60 envios por hora por usuário. Arquivos ficam guardados por 30 dias. Teste com um número seu antes de liberar.")

**Interfaces:**
- Produces: `validateAttachmentFile(f: {name: string; size: number; type: string}): {ok: true; kind: "image"|"video"|"document"} | {ok: false; error: string}` — checagem rápida só por extensão/tamanho (a API valida os bytes): imagens `jpg|jpeg|png|webp`, vídeos `mp4|mov`, documentos `pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv`; mensagens em português ("Arquivo acima de 16 MB", "Tipo de arquivo não suportado"). `<AttachmentComposer conversationId disabled onSent />`: botão de clipe com menu (Imagem/Vídeo, Documento), `<input type="file">` oculto, `onDrop` na área de mensagens, diálogo de pré-visualização (miniatura da imagem, player do vídeo, ícone+nome do documento) com campo de legenda, envio via `apiFetch("/messages/send-attachment", {method:"POST", body: FormData})` com `conversation_id` e `caption` **antes** de `file`; mostra erro da API no diálogo e mantém o arquivo para reenviar. Só renderiza com `currentOrg.settings.seller_attachments_enabled === true`.
- Bolha: `isHuman` com `media_type` em `image|video|document` e `send_failed_at` mostra "Anexo não enviado" em vermelho; anexos enviados usam o mesmo `<ChatMedia>` (a Task 11 já autoriza `human_agent`).

- [ ] **Step 1: Testes (falham)** de `validateAttachmentFile`: `foto.JPG` 3 MB ok `image`; `video.mp4` 17 MB → erro de 16 MB; `planilha.xlsx` 20 MB ok; `script.exe` → erro de tipo; arquivo sem extensão → erro; nome com ponto duplo `a.pdf.exe` → erro.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar picker, componente e integrações (chat com a flag desligada não mostra clipe). **Step 4:** testes + build web → PASS. **Step 5: Verificação visual** no preview: selecionar, arrastar, legenda, erro de tipo/tamanho, envio com a API local falhando (erro visível e arquivo mantido). **Commit:** `feat(web): anexos no chat (clipe, pré-visualização, arrastar-e-soltar)`.

**→ Fim da Etapa 3: PR, revisão, ok do dono. Teste real pelo dono com a flag ligada: enviar imagem, PDF e vídeo do CRM e conferir no celular.**

---

## Self-Review (feito)

- **Cobertura do spec:** layout+flag (T6-7), foto com fallback/atualização/job (T1-5), migração/buckets (T1), receber imagem/vídeo/documento + limites + retenção + `no_store` + falha com "tentar de novo" (T8-12), enviar anexos com pré-visualização/legenda/arrastar-e-soltar/erro e reenvio (T13-16), testes e riscos (em cada task). Fora de escopo respeitado.
- **Lacuna conhecida e aceita:** "reenviar" um anexo que falhou é pelo próprio diálogo (arquivo mantido) quando o erro é da API; falha do Evolution depois do enfileiramento mostra "Anexo não enviado" e a atendente escolhe o arquivo de novo (sem botão de reenvio automático).
- **Consistência de nomes:** `profile_picture_path`/`profile_picture_checked_at`, `buildChatMediaRef`/`isChatMediaRefFor`, `enqueueStoreChatMedia`, `storedMediaRef`, `SellerAttachmentSendError`, flags `inbox_whatsapp_layout_enabled`/`seller_attachments_enabled` usados igual em todas as tasks.
