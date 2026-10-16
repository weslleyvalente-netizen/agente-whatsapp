# Player de áudio nas conversas (áudio guardado + transcrição)

Aprovado pelo usuário em chat (2026-10-16). Hoje nenhum áudio é guardado (`messages.media_url` é nulo nos áudios; só existe a transcrição, e só quando a IA processa a mensagem — áudios recebidos com atendimento humano ativo nem chegam a ser transcritos). Objetivo: o vendedor toca o áudio do cliente dentro da conversa (Inbox e conversa embutida no card do funil), no computador e no celular, e a transcrição continua visível.

## Decisões já tomadas
- Guardar o arquivo em **bucket PRIVADO** do Supabase Storage, `customer-audio` (o bucket `agent-media` existente é público: NÃO usar para áudio de cliente). Acesso só por **link temporário (signed URL, ~5 min)** emitido pela API depois de checar permissão.
- Só áudios **recebidos do cliente** (`role = 'contact'`, `media_type = 'audio'`), apenas **novos** (sem retroativo: o arquivo do WhatsApp expira).
- A captura deve acontecer **para todo áudio de cliente, independentemente de a IA estar ativa** (não dentro do caminho `process-message` que só roda quando a IA responde). Procure como o webhook (apps/api/src/routes/webhooks/evolution.ts) grava a mensagem e como a transcrição busca a mídia na Evolution (packages/agent-runtime: transcribeAudioMessage / fetch de base64) e reutilize o mesmo método de download. Prefira um job assíncrono (BullMQ, padrão já usado em apps/worker e packages/queue) disparado quando a mensagem de áudio é gravada, para não atrasar o webhook; falha no download/upload nunca pode derrubar o recebimento da mensagem nem o fluxo da IA (registrar log e seguir; o player mostra "áudio indisponível").
- Guardar no `messages.media_url` uma referência estável do tipo `storage:customer-audio/<organization_id>/<conversation_id>/<message_id>.<ext>` (distinguível de URLs http públicas que outras mídias usam). Extensão pelo tipo do arquivo (use `pickAudioFileExtension` se aplicável). Nunca gravar URL assinada.
- **Retenção de 90 dias:** rotina periódica (padrão de job repetível já usado no worker, 1x por dia) que apaga do bucket os arquivos de mensagens com mais de 90 dias e zera `media_url` dessas mensagens. A transcrição/texto permanece.

## Banco (migration `20261016120000_customer_audio_bucket.sql`)
- `INSERT INTO storage.buckets (id, name, public) VALUES ('customer-audio','customer-audio', false) ON CONFLICT (id) DO NOTHING;` Sem policies de acesso para `anon`/`authenticated` (acesso só pela chave de serviço da API/worker). Comentar a migration em português. Nenhuma outra mudança de esquema.

## API (apps/api)
- `GET /messages/:messageId/audio-url`: exige login; carrega a mensagem + conversa; permissão = membro da organização E (se o filtro por vendedor estiver ativo — siga o padrão de `canViewLead`/`isSellerFilterEnabled` em apps/api/src/lib) dono da conversa visível ao usuário; só mensagens com `media_url` começando por `storage:customer-audio/`; devolve `{ url, expiresIn }` com signed URL de 300 s. 404 se não houver áudio guardado, 403 sem permissão. Validar `messageId` como uuid. Testes vitest no padrão das rotas existentes (permissão, vendedor de outra carteira bloqueado, sem arquivo → 404, sucesso).

## Worker / captura (apps/worker, apps/api webhook, packages)
- Job `store-customer-audio` (nome a critério, seguindo a convenção local): baixa o áudio via Evolution (mesmo mecanismo da transcrição), faz upload no bucket privado com `upsert: false`, atualiza `media_url`. Idempotente (se já tem `media_url`, não refaz). Retentativas limitadas (use o padrão de attempts/backoff da fila). Teste unitário com mocks (sucesso, falha de download não lança, idempotência).
- Rotina de retenção com teste unitário (apaga >90 dias, mantém o resto, zera media_url).

## Web (apps/web)
- `components/inbox/message-bubble.tsx`: para mensagens de áudio com `media_url` começando por `storage:`, mostrar um player compacto: botão ▶ "Ouvir" que, no primeiro toque, chama a API (`apiFetch(/messages/:id/audio-url)`), define o `src` de um `<audio controls preload="none">` e toca; tratar erro ("Áudio indisponível") e expiração (se o link vencer, pedir outro ao tocar de novo). Mostrar a duração se houver em `metadata.duration_seconds`. A transcrição/rótulo "Áudio sem transcrição" continua como está. Para áudios sem arquivo guardado (antigos), manter o comportamento atual. Funciona em celular (alvo de toque >= 44 px). Não alterar a aparência das demais mensagens.
- Se o tipo `Message` em packages/shared precisar de ajuste, faça mínimo.

## Fora do escopo
Transcrever áudios recebidos durante atendimento humano (sugerir no relatório, mas NÃO implementar); retroativo; áudios enviados pelo atendente.

## Verificação
tsc de api/web/worker/shared/database; vitest de api, worker, shared; `next build` com `NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy`. Não fazer push, não abrir PR, não tocar em produção, sem subagentes. Commits terminando com: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>.
