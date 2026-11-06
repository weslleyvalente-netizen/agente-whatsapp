# Runbook: Áudio do vendedor no chat

## O que faz
O vendedor grava um áudio no chat do CRM e ele chega ao cliente no WhatsApp como mensagem de voz. Também conta como mensagem do vendedor: ativa o takeover humano (como qualquer envio manual) e fecha a tarefa "Cutucar cliente" da conversa.

## Chave e como ligar/desligar
`organizations.settings.seller_audio_enabled` (padrão **desligado**; só `true` liga). Em **Configurações**: switch "Vendedor pode gravar e enviar áudio no chat". Desligado, o botão de gravar some e a rota `POST /messages/send-audio` responde **404**. Desligar vale na hora para novos envios; áudios já enviados continuam no chat.

## Fluxo
Navegador (MediaRecorder) grava -> `POST /messages/send-audio` (multipart: `conversation_id` e `duration_seconds` antes do arquivo) -> API valida, salva no bucket `customer-audio` e enfileira o job -> worker `send-message` -> Evolution `sendWhatsAppAudio`. O player aparece na bolha do CRM a partir do arquivo guardado.

## Limites
- Duração: no máximo 5 min, no mínimo 1 s (o gravador do navegador impõe).
- Tamanho: 3 MB.
- Formato: webm, mp4 ou ogg, conferido pela assinatura dos bytes (não só pelo tipo declarado).
- Taxa: 30 envios por hora por organização+usuário, em memória (zera ao reiniciar a API). Falha antes do upload devolve a vaga.
- Retenção: 90 dias, no mesmo bucket e na mesma limpeza dos áudios de clientes.

## Falha: "Áudio não enviado"
A bolha mostra "Áudio não enviado" quando `metadata.send_failed_at` está preenchido. **Não há retry automático nem fallback em texto**: o vendedor grava de novo. Causa nos logs do worker: procure `Evolution API audio send error`.

## Checklist de go-live (dono, número próprio)
1. Ligar a chave só para o teste.
2. Gravar no **Chrome desktop** (webm) e num **iPhone** (mp4) e enviar.
3. Conferir: chega como mensagem de voz tocável no WhatsApp; o player aparece na bolha do CRM; a tarefa "Cutucar cliente" fecha.
4. Se a Evolution recusar algum formato, **não liberar**: converter com ffmpeg no worker é o plano de contingência e vira tarefa nova.

## Limitações conhecidas
- Envio com falha **não desfaz o takeover** já ativado.
- Precisa de permissão de microfone no navegador.
- A interface não foi verificada visualmente antes do release: o dono deve conferir (gravar, revisar, enviar, bolha de erro).

## Diagnóstico rápido
| Sintoma | Causa provável |
|---|---|
| 404 ao enviar | Chave desligada (ou conversa inexistente) |
| 400 | Formato não suportado, arquivo vazio ou conversa inválida |
| 403 | Lead de outro vendedor / sem acesso à organização |
| 413 | Áudio acima de 3 MB |
| 429 | Limite de 30 por hora atingido |
| 500 ao enviar | Falha ao salvar/enfileirar; ver log da API |
| "Áudio não enviado" | Falha no worker; ver `Evolution API audio send error` |
