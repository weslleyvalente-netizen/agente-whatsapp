# Áudio do vendedor no chat do CRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O vendedor grava e envia áudio ao cliente pelo chat do CRM (PC e celular); o cliente recebe mensagem de voz e o CRM mostra o player.

**Architecture:** O navegador grava (`MediaRecorder`) e envia multipart para `POST /messages/send-audio`. A API valida, salva a mensagem, guarda o arquivo no bucket privado `customer-audio` e enfileira o job; o worker baixa do bucket e chama a Evolution `sendWhatsAppAudio`, sem fallback para texto e sem retentativa. Tudo atrás da chave `seller_audio_enabled` (padrão desligada).

**Tech Stack:** Fastify + `@fastify/multipart`, Supabase Storage, BullMQ, Next.js/React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-audio-vendedor-design.md`

## Global Constraints

- Formatos aceitos: `audio/webm`, `audio/mp4`, `audio/ogg`; tamanho máx. **3 MB**; gravação máx. **300 s**, mínima **1 s**.
- Bucket `customer-audio`, caminho `<org>/<conversa>/<messageId>.<ext>`, `media_url` = `buildCustomerAudioRef(...)` (retenção 90 dias já existente).
- Mensagem: `role="human_agent"`, `media_type="audio"`, `content="[audio]"`, `metadata.source="seller_audio"`.
- Chave `organizations.settings.seller_audio_enabled`: só `=== true` liga; desligada → rota 404 e botão escondido.
- Permissões idênticas a `POST /messages/send` (membro da org + `canViewLead`). Limite 30 envios/hora por org+usuário (em memória).
- Áudio do vendedor: job com `attempts: 1`; falha nunca vira texto.
- Textos de interface em português. Sem migration.

## Review Focus

1. Arquivo que não é áudio com `Content-Type` de áudio (falsificado) → 400 pela assinatura dos bytes. (Task 1, Task 2)
2. Lead de outro vendedor ou de outra organização → 403, nada gravado nem enviado. (Task 2)
3. Evolution falha ao enviar áudio do vendedor → nenhum texto é enviado, nenhuma retentativa, mensagem marcada `send_failed_at`. (Task 3)
4. Duplo clique em Enviar → uma única mensagem. (Task 5)
5. Trocar de conversa/fechar o painel durante a gravação → microfone liberado, nada enviado. (Task 5, Task 6)

---

### Task 1: Tipos e helpers compartilhados

**Files:**
- Create: `packages/shared/src/seller-audio.ts` (+ `seller-audio.test.ts`), exportar em `packages/shared/src/index.ts`
- Modify: `packages/shared/src/types/organization.ts` (settings), `packages/shared/src/types/message.ts` (`MessageMetadata`), `packages/queue/src/types.ts` (`SendMessageJobData`)

**Interfaces:**
- Produces: `SELLER_AUDIO_MAX_BYTES = 3*1024*1024`, `SELLER_AUDIO_MAX_SECONDS = 300`, `SELLER_AUDIO_MIN_SECONDS = 1`; `detectSellerAudioFormat(bytes: Uint8Array): { extension: "webm" | "mp4" | "ogg"; mimeType: string } | null`; `MessageMetadata.send_failed_at?: string` e `source` ganha `"seller_audio"`; `SendMessageJobData.storedAudioRef?: string`; `OrganizationSettings.seller_audio_enabled?: boolean`.

- [ ] **Step 1: Testes** em `seller-audio.test.ts`: `detectSellerAudioFormat` devolve `webm` para bytes `1A 45 DF A3 …`, `mp4` para `00 00 00 18 66 74 79 70 …` ("ftyp" nos bytes 4–7), `ogg` para `4F 67 67 53 …` ("OggS"); devolve `null` para texto (`"hello world"`), para PNG e para buffer vazio/curto.
- [ ] **Step 2:** Rodar `pnpm --filter @aula-agente/shared test seller-audio` — falha (módulo inexistente).
- [ ] **Step 3:** Implementar o módulo e os campos de tipo acima.
- [ ] **Step 4:** Rodar o teste — passa; `pnpm --filter @aula-agente/shared build` e `pnpm --filter @aula-agente/queue build` sem erro.
- [ ] **Step 5:** Commit `feat: tipos e helpers do áudio do vendedor`.

### Task 2: Rota `POST /messages/send-audio`

**Files:**
- Create: `apps/api/src/routes/messages/send-audio.ts` (+ `send-audio.test.ts`)
- Modify: `apps/api/src/services/message-send.service.ts` (+ teste existente), registro da rota onde `messageSendRoutes` é registrada (achar com `grep -rn messageSendRoutes apps/api/src`)

**Interfaces:**
- Consumes: Task 1 (`detectSellerAudioFormat`, constantes, `buildCustomerAudioRef`, `SendMessageJobData.storedAudioRef`); `setMessageMediaUrlIfEmpty` de `@aula-agente/database`; `enqueueSendMessage(data, { attempts: 1 })` de `apps/api/src/lib/queue.ts`.
- Produces: `sendPanelMessage(params)` aceita `audio?: { buffer: Buffer; extension: "webm" | "mp4" | "ogg"; durationSeconds?: number }`; com `audio`: salva a mensagem (`content "[audio]"`, `mediaType "audio"`, `metadata {source:"seller_audio", duration_seconds}`), faz upload em `customer-audio` no caminho de `buildCustomerAudioRef`, grava `media_url` e enfileira com `storedAudioRef` e `attempts: 1`; takeover, primeira resposta humana e `trackFirstHumanMessage` seguem iguais. Rota responde `200 {ok:true, messageId}`; erros em português: 400 (sem arquivo, vazio, formato inválido), 413 (>3 MB), 404 (chave desligada), 403, 429.

- [ ] **Step 1: Testes** (padrão de `agent-config/images.test.ts` com `app.inject` + multipart; campo `conversation_id` ANTES do arquivo): (a) webm válido → 200, `sendPanelMessage` chamado com `audio.extension="webm"`; (b) bytes de PNG com `Content-Type: audio/webm` → 400; (c) arquivo vazio → 400; (d) 3 MB + 1 byte → 413; (e) chave desligada → 404 e nada chamado; (f) membro de outra org → 403; (g) lead de outro vendedor (`canViewLead` falso) → 403; (h) 31º envio na mesma hora → 429; (i) sem arquivo → 400. No serviço: com `audio`, upload falhando → mensagem fica com `metadata.send_failed_at` e a função lança (nada é enfileirado); sucesso → `enqueueSendMessage` recebe `storedAudioRef` igual ao `media_url` e `{attempts: 1}`.
- [ ] **Step 2:** Rodar `pnpm --filter @aula-agente/api exec vitest run src/routes/messages src/services/message-send` — falha.
- [ ] **Step 3:** Implementar a rota (registrar `multipart` no escopo da rota com `limits: { fileSize: SELLER_AUDIO_MAX_BYTES, files: 1 }`; `FST_REQ_FILE_TOO_LARGE` → 413) e estender `sendPanelMessage`. Limite por hora: mesmo padrão de `takeSuggestionSlot` em `routes/opportunities/message-suggestion.ts`, em módulo próprio da rota.
- [ ] **Step 4:** Testes passam; `pnpm --filter @aula-agente/api exec tsc --noEmit` limpo.
- [ ] **Step 5:** Commit `feat: rota de envio de áudio do vendedor`.

### Task 3: Worker envia o áudio sem fallback

**Files:**
- Modify: `apps/worker/src/workers/send-message.ts`, `apps/worker/src/workers/send-message.test.ts`

**Interfaces:**
- Consumes: `SendMessageJobData.storedAudioRef` (Task 1/2), `parseCustomerAudioRef`, `updateMessageContent(db, id, content, metadata)` de `@aula-agente/database`.

- [ ] **Step 1: Testes** (estilo do arquivo): (a) job com `storedAudioRef` → baixa do storage (mock `db.storage.from(bucket).download(path)`), chama `/message/sendWhatsAppAudio/<instância>` com `audio` em base64 e `encoding: true`, e **não** chama `sendText`; (b) Evolution responde erro → o job lança, **nenhuma** chamada a `sendText`, e a mensagem recebe `metadata.send_failed_at` (via `updateMessageContent` preservando o conteúdo `"[audio]"`); (c) download do storage falha → mesmo comportamento de (b); (d) o fluxo atual com `audioBase64` (TTS da IA) continua caindo para texto quando falha — teste existente deve seguir passando.
- [ ] **Step 2:** Rodar `pnpm --filter @aula-agente/worker exec vitest run src/workers/send-message.test.ts` — (a)–(c) falham.
- [ ] **Step 3:** Em `processSendMessageJob`, ramo novo antes do de `audioBase64`: baixar via `getAdminClient().storage`, converter para base64, `sendEvolutionAudio`; no catch marcar `send_failed_at` e relançar. Persistir `evolution_message_id` como nos outros ramos.
- [ ] **Step 4:** Testes passam; `pnpm --filter @aula-agente/worker exec tsc --noEmit` limpo.
- [ ] **Step 5:** Commit `feat: worker envia áudio do vendedor sem fallback para texto`.

### Task 4: Player serve áudio do vendedor

**Files:**
- Modify: `apps/api/src/routes/messages/audio-url.ts`, `apps/api/src/routes/messages/audio-url.test.ts`

- [ ] **Step 1: Testes:** mensagem `human_agent` com `media_type="audio"` e `media_url` do próprio registro → 200 com URL assinada; `human_agent` com `media_url` apontando para outro caminho → 404; role `agent` → 404 (continua); permissões (outra org, lead de outro vendedor) inalteradas. Ajustar o teste existente que afirma "só contact".
- [ ] **Step 2:** Rodar `pnpm --filter @aula-agente/api exec vitest run src/routes/messages/audio-url.test.ts` — falha nos novos.
- [ ] **Step 3:** Trocar a condição `message.role !== "contact"` por `!["contact", "human_agent"].includes(message.role)`; manter `isCustomerAudioRefFor`.
- [ ] **Step 4:** Testes passam. **Step 5:** Commit `feat: player serve áudio enviado pelo vendedor`.

### Task 5: Gravador no navegador (lógica pura + hook)

**Files:**
- Create: `apps/web/src/lib/audio-recorder.ts` (+ `audio-recorder.test.ts`), `apps/web/src/hooks/use-audio-recorder.ts`
- Modify: `apps/web/src/lib/api.ts` (não forçar `Content-Type: application/json` quando `body instanceof FormData`)

**Interfaces:**
- Produces (puro, testável): `pickRecorderMimeType(isSupported: (t: string) => boolean): string | null` (ordem `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4`; `null` se nenhum); `type RecState = { phase: "idle" | "recording" | "review" | "sending"; seconds: number }`; `recorderReducer(state: RecState, action: { type: "start" } | { type: "tick" } | { type: "stop" } | { type: "discard" } | { type: "send" } | { type: "sent" } | { type: "failed" }): RecState`.
- Produces (hook): `useAudioRecorder(): { supported: boolean; phase; seconds; error: string | null; start(): Promise<void>; stop(): void; discard(): void; send(upload: (blob: Blob, seconds: number) => Promise<void>): Promise<void>; previewUrl: string | null }`.

- [ ] **Step 1: Testes do módulo puro:** `pickRecorderMimeType` escolhe webm/opus quando suportado, cai para `audio/mp4` (iPhone), `null` quando nada; reducer: `start` → recording com 0 s; `tick` incrementa só em recording; ao chegar em 300 s o próximo `tick` leva a `review`; `stop` com menos de 1 s volta a `idle` (descarta); `send` fora de `review` é ignorado e `send` repetido em `sending` é ignorado (duplo clique); `failed` volta a `review`; `sent` volta a `idle`.
- [ ] **Step 2:** Rodar `pnpm --filter web exec vitest run src/lib/audio-recorder.test.ts` — falha.
- [ ] **Step 3:** Implementar o módulo puro e o hook (`getUserMedia({audio:true})`, `MediaRecorder` com o tipo de `pickRecorderMimeType`, timer de 1 s; no *unmount* e em `discard` chamar `stream.getTracks().forEach(t => t.stop())` e revogar `previewUrl`; erro de permissão → `error = "Permita o uso do microfone para gravar áudio."`; sem suporte → `supported=false`). Ajustar `apiFetch`.
- [ ] **Step 4:** Testes passam; `pnpm --filter web exec tsc --noEmit` limpo.
- [ ] **Step 5:** Commit `feat: gravador de áudio do navegador`.

### Task 6: Interface no chat

**Files:**
- Create: `apps/web/src/components/inbox/audio-recorder-bar.tsx`
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`, `apps/web/src/components/inbox/message-bubble.tsx`, `apps/web/src/lib/customer-audio.ts` (se preciso)

**Interfaces:**
- Consumes: `useAudioRecorder` (Task 5), `POST /messages/send-audio` com `FormData` (`conversation_id` primeiro, depois `audio`, opcional `duration_seconds`).

- [ ] **Step 1:** Botão de microfone no compositor, visível só com `currentOrg?.settings.seller_audio_enabled === true` e `supported` (mesma forma de ler a chave que `opportunity-detail-dialog.tsx`). Estados: gravando (tempo `m:ss` + Cancelar + Parar), revisão (`<audio controls>` com `previewUrl` + Descartar + Enviar), enviando (botões desabilitados). Alvos de toque ≥ 44 px no celular (`size-11 md:size-8`, como o botão de enviar).
- [ ] **Step 2:** `MessageBubble`: mostrar `CustomerAudioPlayer` também para `human_agent` com `hasStoredAudio`; se `metadata.send_failed_at` existir, mostrar "Áudio não enviado" em destaque.
- [ ] **Step 3:** Ao enviar com sucesso: `fetchConversation()` e `onConversationChanged?.()` como no envio de texto; erro → mensagem da API sem perder a gravação (volta para revisão).
- [ ] **Step 4:** Verificar no navegador de pré-visualização (`preview_start`) o botão com a chave ligada/desligada e o layout em largura de celular (375 px); `pnpm --filter web exec tsc --noEmit` e `pnpm --filter web build` sem erro.
- [ ] **Step 5:** Commit `feat: gravar e enviar áudio no chat`.

### Task 7: Chave em Configurações

**Files:**
- Modify: `apps/web/src/app/(dashboard)/settings/page.tsx`

- [ ] **Step 1:** Adicionar `"seller_audio_enabled"` à união de `toggleWorkspace` e à lista `isLead`, e um `Switch` "Vendedor pode gravar e enviar áudio no chat" com texto explicativo (usa o microfone do aparelho; áudios ficam guardados 90 dias), no mesmo padrão do switch de sugestão de mensagem.
- [ ] **Step 2:** `pnpm --filter web exec tsc --noEmit` limpo; conferir o switch no navegador de pré-visualização.
- [ ] **Step 3:** Commit `feat: chave para ligar o áudio do vendedor`.

### Task 8: Verificação real e runbook

**Files:**
- Create: `docs/runbook-audio-vendedor.md`

- [ ] **Step 1:** Com a chave ligada só para teste (dono), enviar para um número de teste um áudio gravado no **Chrome (webm)** e um no **iPhone (mp4)**; conferir: chega como mensagem de voz tocável no WhatsApp, o player aparece no CRM, e a tarefa "Cutucar cliente" da conversa fecha.
- [ ] **Step 2:** Se a Evolution recusar algum formato, parar e reportar: a decisão (converter com ffmpeg no worker) vira uma tarefa nova antes de liberar.
- [ ] **Step 3:** Escrever o runbook: como ligar/desligar a chave, o que fazer com "Áudio não enviado", limites (5 min, 3 MB, 30/h), retenção de 90 dias.
- [ ] **Step 4:** Commit `docs: runbook do áudio do vendedor`.
