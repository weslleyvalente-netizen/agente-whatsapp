# Instância Evolution dos avisos internos e envios que falham

## O que mudou
- **Avisos internos** (resumo de leads sem resposta e alertas do monitor de saúde) saem só por instância **comprovadamente conectada**: o estado é consultado na própria Evolution (`/instance/connectionState`), não no status gravado no banco (que não é confiável: já mostrou `disconnected` para a instância conectada).
- Ordem: instâncias abertas, a mais antiga primeiro (a principal). Fechada ou conectando nunca entra. Se a Evolution não responde (estado desconhecido), as instâncias com agente ativo entram como último recurso.
- Recusa explícita da Evolution (ex.: HTTP 400) passa para a próxima instância conectada. Timeout ou erro de rede **para** (a requisição pode ter saído): nunca duplica o aviso.
- **Não muda a instância das conversas comerciais**: cada conversa continua presa à sua `evolution_instance_id`. Nenhuma conversa, instância, conexão, credencial ou configuração é alterada.
- O erro de envio passa a registrar instância, status HTTP e a mensagem da Evolution, **sem chaves, URLs nem telefones**.
- O monitor de saúde nomeia a instância desconectada no alerta e registra um erro (uma vez) quando duas instâncias reportam o **mesmo número** de WhatsApp.

## Mensagens que falham não contam mais como entregues
- Quando a **última tentativa** de envio falha, a mensagem (já gravada ao enfileirar) recebe `metadata.send_failed_at` e `metadata.send_error`.
- Mensagem marcada **não** conta como resposta em: varredura de leads sem resposta, aposentadoria de tarefas de silêncio, "última mensagem nossa" da recuperação, follow-up automático de conversa parada e follow-up de baixa intenção.
- Sem migração: reaproveita a chave `send_failed_at` que o áudio/anexo do vendedor já usava.

## Achados da investigação (14/11/2026)
- Digest e monitor escolhiam a instância **mais nova** com agente ativo; era a "Pos venda" (desconectada) → HTTP 400 e o digest nunca saía.
- A única conversa da "Pos venda" (lead de anúncio no status) teve 2 respostas da MarIAna que nunca saíram. A segunda era um follow-up automático disparado **porque a primeira, que falhou, contava como entregue**.
- Outras mensagens nossas sem `evolution_message_id` e sem entrega (desde 15/10): 11. Em 6 há envio posterior bem-sucedido na mesma conversa (provável falha só do preenchimento do id). Possíveis não entregues, a conferir: 1 conversa de 18/10, 1 de 13/11 16:17 e a conversa da "Pos venda". Sem backfill automático: nada foi reenviado.
- As duas instâncias aparecem no Evolution Manager com o **mesmo número**. O banco não guarda o número da instância (`phone_number` vazio nas duas), então a associação instância → número não é validada em lugar nenhum.

## Reversão e implantação
- Sem migração e sem nova configuração. Reverter = reimplantar o commit anterior.
- Depois do deploy: o log do digest mostra `alert sent via instance <nome>`; sem `digest failed`; `health-monitor` nomeia a instância desconectada.
