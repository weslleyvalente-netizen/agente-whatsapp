# Conversas no estilo WhatsApp Web (layout, fotos e anexos) — Design

Data: 2026-11-08 · Subprojeto 1 de 4 (os outros ficam fora: número do pós-venda, Google Contatos/Agenda, decisão UAZAPI).

## Objetivo e contexto

As atendentes estão acostumadas ao WhatsApp Web e há atraso no atendimento pelo CRM. A aba **Conversas** deve ficar parecida com o WhatsApp Web, com a foto do cliente, e permitir **enviar e receber** imagens, documentos e vídeos (o áudio já existe e não muda). Foco em **computador**.

Sucesso: a atendente atende pelo CRM sem sentir falta do WhatsApp Web para o dia a dia (ver foto, ver o que o cliente mandou, mandar imagem/PDF/vídeo).

## Restrições

- Cada etapa é um PR separado, mergeado só com ok explícito do dono. Migrações de produção são coladas por ele no SQL editor do Supabase.
- Nada novo fica público: arquivos em buckets privados, acesso por link assinado curto, depois de checar permissão do vendedor sobre o lead.
- Falha de mídia/foto nunca derruba o webhook nem o recebimento do texto.
- Segue o padrão do áudio do cliente (`storage:<bucket>/<path>`, job no worker, retenção).
- Mensagens antigas não são recuperadas (só texto "[imagem]" etc.).

## Entrega em etapas (um PR cada)

1. **Layout WhatsApp Web + foto de perfil**, atrás de uma flag por organização (desligada de início). Inclui a migração (colunas de foto + bucket).
2. **Receber mídia** (imagem, vídeo, documento) guardada e exibida.
3. **Enviar anexos** (clipe, pré-visualização, legenda, arrastar-e-soltar). Por último por mexer no envio.

## Etapa 1 — Layout e foto de perfil

- Reskin dos componentes de `apps/web/src/components/inbox/*` (lista, cabeçalho, bolhas, composer) sob a flag; com a flag desligada nada muda. A flag fica na configuração da organização, alterável pelo gerente.
- Lista de conversas: avatar, nome, prévia, hora, contador de não lidas; painel central de chat com fundo claro, bolhas de entrada/saída, hora e ticks; composer com campo multilinha (Enter envia, Shift+Enter quebra linha).
- **Avatar:** foto do contato por link assinado; sem foto, círculo com iniciais e cor estável derivada do contato.
- **Busca da foto:** quando chega mensagem de contato sem foto guardada ou com foto de mais de 7 dias (e sem tentativa recente), enfileira job `fetch-profile-picture`. O job pede a URL ao Evolution, baixa a imagem, guarda no bucket privado `profile-pictures` e grava o caminho. Só para contatos com atividade recente. Falha ou foto oculta: registra a tentativa e segue com iniciais.
- **Banco (migração colada pelo dono):** em `wa_contacts` as colunas `profile_picture_path text`, `profile_picture_checked_at timestamptz`; criação dos buckets privados `profile-pictures` e `chat-media`; coluna/ajuste de flag em configurações da organização. Detalhe final de colunas e policies fica no plano.

## Etapa 2 — Receber mídia

- No webhook, ao receber `imageMessage`, `videoMessage` ou `documentMessage` (não ignorado `no_store`), a mensagem continua sendo salva como hoje (legenda/nome/"[imagem]") e enfileira o job `store-chat-media`.
- O job baixa o arquivo do Evolution (base64), valida tamanho, grava em `chat-media` (`<org>/<conversa>/<mensagem>.<ext>`), grava `messages.media_url = storage:chat-media/...` e `media_type` (`image|video|document`), além de nome/mime/tamanho (em coluna de metadados na mensagem; definição exata no plano). Idempotente (`setMessageMediaUrlIfEmpty`), retentativas só para falhas transitórias, falhas permanentes marcadas.
- **Limites:** imagem e vídeo até 16 MB, documento até 25 MB. Acima: a bolha mostra "Arquivo grande, abra no celular da loja".
- **Exibição:** imagem = miniatura que abre ampliada; vídeo = player embutido; documento = cartão com ícone, nome, tamanho e botão baixar.
- **Acesso:** endpoint da API gera link assinado curto (padrão de `audio-url.ts`) após checar permissão do vendedor no lead.
- **Retenção:** 30 dias, limpeza por worker de retenção nos moldes do áudio; após expirar a bolha mostra "Arquivo expirado". Contatos ignorados com `no_store` nunca têm arquivo guardado.
- Falha de download: a mensagem fica com o texto e um botão "tentar de novo".

## Etapa 3 — Enviar anexos

- Botão de clipe no composer (imagem, documento, vídeo) e arrastar-e-soltar; pré-visualização com legenda opcional antes de enviar.
- O navegador envia o arquivo à API (multipart, como o áudio do vendedor); a API valida os bytes, o tipo e o tamanho (imagem ≤ 16 MB, vídeo ≤ 16 MB, documento ≤ 25 MB), guarda em `chat-media` e cria a mensagem de saída; o worker (`send-message.ts`) envia pelo Evolution (`sendEvolutionMedia` estendido para vídeo e documento). O envio fica atrás de uma flag própria `seller_attachments_enabled`, limitada a 60 envios por hora por usuário.
- Mesmas regras de autorização do envio de texto/áudio (vendedor só no seu lead; limites existentes).
- Falha no envio: erro visível na bolha e opção de reenviar.

## Testes

- Automáticos: download/armazenamento de mídia, limites e tipos, permissão por vendedor no link assinado, `no_store`, retenção, fallback de foto, job de foto com falha do Evolution, validação do envio.
- Revisão independente de cada PR antes do pedido de ok.
- Teste real pelo dono com a flag ligada: mandar imagem, PDF e vídeo do celular para o número da loja e ver no CRM; enviar um anexo do CRM e conferir no celular.

## Riscos

- **Armazenamento e egress do Supabase** (já preocupação do dono): mitigados por limites, retenção de 30 dias e miniaturas.
- Envio de anexos pelo Evolution/Baileys pode se comportar diferente por tipo; testar cada tipo em produção na etapa 3.
- A sessão do Evolution ainda pode ficar "zumbi" (problema à parte); anexos não resolvem nem pioram isso.

## Fora de escopo

Figurinhas, GIFs, localização, contatos compartilhados, enquetes, responder citando, reações, encaminhar, mensagens apagadas/editadas, recuperar mídia antiga, segundo número, Google Contatos/Agenda e UAZAPI.
