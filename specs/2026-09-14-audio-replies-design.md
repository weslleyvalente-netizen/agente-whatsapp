# Respostas em áudio da Helena — Design

## Contexto

A Helena já recebe áudio do cliente (transcrito via Whisper em
`apps/worker/src/lib/audio-transcription.ts`), mas sempre responde em
texto. O pedido é fazer ela responder com nota de voz quando fizer
sentido, usando a chave da OpenAI que a organização já tem configurada
(a mesma usada hoje pra transcrição).

## Comportamento

- **Gatilho**: espelha a modalidade do cliente. Se a mensagem que
  originou a resposta foi um áudio (`media_type === "audio"`), a
  resposta pode sair em áudio. Se o cliente escreveu texto, a resposta
  sai em texto — nunca o contrário.
- **Interruptor por agente**: novo campo `audio_replies` (boolean,
  padrão `false`) em `tools_config`, ao lado dos outros toggles
  (`send_catalog_photo`, `create_task`, etc.). Desligado = comportamento
  de hoje, sempre texto, independente do que o cliente mandou.
- **Voz**: novo campo `audio_voice` (string, padrão `"alloy"`) também em
  `tools_config`, com uma lista de opções conhecidas da OpenAI TTS
  exposta como select na mesma tela. **A confirmar antes da
  implementação**: a lista exata de vozes disponíveis hoje na API da
  OpenAI (não pôde ser verificada ao vivo durante o design por limite de
  sessão de busca) — `alloy` é uma opção estável e presente em todas as
  versões conhecidas da API, então serve como padrão seguro mesmo que a
  lista completa mude.
- **Queda automática pra texto** mesmo com o gatilho satisfeito, quando
  a resposta gerada:
  - contém uma URL (regex `https?://`), ou
  - tem 2 ou mais linhas que parecem lista/opções (linhas começando com
    `🔹`, `-`, `•`, ou padrão `\d+[.)]`).

  Motivo: link falado em voz alta é inútil, e lista de preços/opções é
  difícil de acompanhar de ouvido.
- **Falha na geração do áudio**: qualquer erro (timeout, API fora,
  etc.) cai para o envio em texto normal — o cliente nunca fica sem
  resposta por causa de um problema no TTS.

## Fluxo

```
cliente manda áudio
  → Whisper transcreve (já existe)
  → Helena gera a resposta em texto (já existe)
  → tools_config.audio_replies ligado?
      não → envia texto (fluxo de hoje)
      sim → mensagem que originou foi áudio?
              não → envia texto
              sim → resposta é "complexa" (link ou lista)?
                      sim → envia texto
                      sim (falhou geração do áudio) → envia texto
                      não → gera áudio via OpenAI TTS → envia nota de voz
```

## Componentes

- **`apps/worker/src/lib/audio-generation.ts`** (novo) — simétrico ao
  `audio-transcription.ts` existente. Usa `resolveApiKey(organizationId,
  "openai")` (mesmo padrão já usado na transcrição) e chama
  `POST https://api.openai.com/v1/audio/speech` com o texto da
  resposta, a voz configurada, e o modelo TTS da OpenAI. Retorna o
  áudio como base64 (ou `{ ok: false, reason }` em caso de erro,
  seguindo o mesmo formato de retorno de `transcribeAudioMessage`).

- **`apps/worker/src/workers/process-message.ts`** — depois de gerar a
  resposta em texto (`runAgent`), decide se deve tentar áudio (checa
  `tools_config.audio_replies`, `currentMessage.media_type ===
  "audio"`, e a heurística de conteúdo complexo). Se sim, chama
  `generateSpeech`; se der certo, inclui o áudio em base64 no job
  enfileirado para `send-message`; se falhar ou não se aplicar, segue
  como hoje (só texto).

- **`packages/queue`** — `SendMessageJobData` ganha um campo opcional
  `audioBase64?: string`.

- **`apps/worker/src/workers/send-message.ts`** — nova função
  `sendEvolutionAudio(instanceName, phone, audioBase64)`, chamando
  `POST /message/sendWhatsAppAudio/:instanceName` da Evolution API
  (`{ number, audio: base64, encoding: true }` — confirmado na
  documentação oficial que a Evolution converte automaticamente para o
  formato de nota de voz (PTT) do WhatsApp, então não é preciso se
  preocupar com o formato exato de saída da OpenAI). O worker escolhe
  entre `sendEvolutionAudio`, `sendEvolutionMedia` ou
  `sendEvolutionText` conforme os campos presentes no job.

- **`packages/shared/src/schemas/agent.ts`** — `toolsConfigSchema`
  ganha `audio_replies: z.boolean().default(false)` e `audio_voice:
  z.string().default("alloy")`.

- **`apps/web/src/components/agents/config/ferramentas-section.tsx`** —
  nova linha em `TOOL_ROWS` ("Responder com áudio") e, condicional a
  esse toggle estar ligado, um select de voz.

## Registro no banco

A mensagem continua sendo salva com o texto real gerado (nunca só
"[áudio]") — o histórico no dashboard permanece 100% legível. Se foi
enviada como nota de voz, `media_type` é marcado como `"audio"` (sem
`media_url`, já que o áudio não é hospedado — vai direto em base64 pra
Evolution e é descartado depois do envio).

## Testes

- `audio-generation.ts`: gera áudio com sucesso, retorna `ok: false`
  em erro da API, nunca lança exceção.
- Heurística de conteúdo complexo (função pura, testável isolada):
  detecta URL, detecta lista de 2+ linhas, aceita texto simples.
- `process-message.ts`: decide áudio vs texto corretamente combinando
  toggle + media_type de origem + heurística + resultado da geração
  (sucesso/falha) — mockando `generateSpeech`.
- `send-message.ts`: escolhe a função de envio certa conforme os
  campos do job (texto / mídia / áudio).

## Fora de escopo

- Não cria nenhum storage novo para os arquivos de áudio — tudo em
  base64, na hora, sem persistência.
- Não altera o fluxo de mensagens de texto nem o de mídia (imagem) já
  existentes.
- Não expõe esse comportamento como ferramenta que o próprio modelo
  decide invocar (como `send_catalog_photo`) — é uma decisão mecânica
  do pipeline, não do agente.
