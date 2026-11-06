# Áudio do vendedor no chat do CRM — Design

## Objetivo

O vendedor grava e envia áudio ao cliente direto do chat do CRM, no computador e no celular (CRM instalado como app). O cliente recebe uma mensagem de voz no WhatsApp e o áudio aparece na conversa do CRM com player.

## Decisões já tomadas com o dono

- Só **gravar na hora** (ouvir antes de enviar, descartar). Anexar arquivo de áudio fica fora.
- Abordagem **A**: navegador → API (multipart) → bucket privado + job no worker → Evolution `sendWhatsAppAudio`.

## Fora do escopo

Anexar arquivo de áudio, transcrição do áudio do vendedor para o cliente, vídeo/imagem, waveform, pausar/retomar gravação.

## Componentes

### 1. Web — gravador no chat (`apps/web/src/components/inbox/`)
- Botão de microfone ao lado do campo de texto. Estados: ocioso → gravando (tempo correndo, botão parar/cancelar) → revisão (player + Enviar / Descartar) → enviando.
- `MediaRecorder` com o primeiro formato suportado, nesta ordem: `audio/webm;codecs=opus`, `audio/mp4`. Sem suporte → botão escondido.
- Limite de 5 min (para sozinho e vai para a revisão). Mínimo 1 s (menos que isso é descartado).
- Microfone negado/indisponível → mensagem clara em português; o chat de texto segue normal.
- Ao sair da conversa ou fechar o painel durante a gravação: para a gravação e libera o microfone (`track.stop()`); nada é enviado.
- Unidade isolada: um hook `useAudioRecorder` (estado + blob + duração) e um componente de UI; `ChatPanel` só os monta.

### 2. API — `POST /messages/send-audio` (`apps/api/src/routes/messages/`)
- Multipart (`@fastify/multipart`, já usado em `agent-config/images.ts`): campos `conversation_id` e arquivo `audio`.
- Mesmas permissões de `POST /messages/send`: membro da organização e `canViewLead`.
- Valida: tipo (`audio/webm`, `audio/mp4`, `audio/ogg` — checa o tipo declarado e a assinatura dos primeiros bytes), tamanho máx. 3 MB, arquivo não vazio. Erros → 400/413 com mensagem em português.
- Guarda no bucket privado `customer-audio` em `<org>/<conversa>/<messageId>.<ext>` e grava `media_url` com a referência `storage:` (mesmo formato/helpers de `customer-audio` em `shared`). Retenção igual à dos áudios de cliente (90 dias).
- Reaproveita `sendPanelMessage` (estendido para aceitar áudio): salva a mensagem `role=human_agent`, `media_type=audio`, `content="[audio]"`, ativa takeover, marca primeira resposta humana (e portanto conclui o cutucar), e enfileira o envio.
- Rate limit simples por usuário (ex.: 30/h) para conter abuso.

### 3. Worker — envio (`apps/worker/src/workers/send-message.ts`)
- O job de áudio do vendedor carrega a referência do arquivo (não o base64 dentro do Redis): o worker baixa do bucket, converte para base64 e chama `sendEvolutionAudio` (`encoding: true` converte para voz/PTT).
- Para áudio de vendedor: **sem fallback para texto** (hoje o worker cai para texto quando o áudio da IA falha — mandaria "[audio]" ao cliente) e **sem retentativa automática** (`attempts: 1`, como o follow-up de tarefa), para nunca duplicar.
- Falha no envio → mensagem marcada como não enviada (metadata) para o chat mostrar "não enviado — tentar de novo"; o vendedor decide regravar/reenviar.

### 4. Player no CRM
- `GET /messages/:id/audio-url` hoje só serve `role=contact`. Passa a servir também `human_agent` com `media_type=audio` e referência válida do próprio registro (mesma checagem `isCustomerAudioRefFor`). Permissões inalteradas.
- O chat mostra o player para as duas direções (o componente de áudio do cliente já existe).

## Interação com o que já existe

- **Transcrição de contexto da IA/sugestão:** o áudio do vendedor fica como `[audio]` e cai no mesmo caminho de transcrição sob demanda (`prepareFollowupAudioContext`), já limitado a áudio recente.
- **Eco do webhook:** a Evolution devolve o `evolution_message_id`; o worker já grava esse id na mensagem, então o eco não duplica.
- **Segurança:** `media_url` é editável por membros via RLS; por isso o player só assina o caminho exato da própria mensagem (já é a regra atual).

## Teste e verificação

- Unitários: validação do upload (tipo, assinatura, tamanho, vazio), permissões (outra organização, lead de outro vendedor), worker sem fallback para texto e sem retry, rota de áudio servindo `human_agent`.
- Hook do gravador com `MediaRecorder` simulado: parada no limite, descarte, liberação do microfone.
- **Verificação real obrigatória antes de ligar para o time:** enviar um áudio webm (Chrome) e um mp4 (iPhone) a um número de teste e conferir que chega como mensagem de voz tocável. Se a Evolution não aceitar algum formato, converter no worker (ffmpeg) antes de seguir.

## Rollout

Atrás de uma chave em `organizations.settings` (`seller_audio_enabled`, padrão desligada), ligada pelo dono depois do teste real. Sem migration de banco: reaproveita colunas e bucket existentes.
