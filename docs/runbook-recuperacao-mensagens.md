# Runbook: mensagens perdidas e alerta de silêncio

Contexto: em 16-17/10/2026 o Redis ficou parado por ~9 h. A API seguiu no ar, mas a Evolution não conseguiu entregar as mensagens à fila, então nenhum cliente foi respondido. Este runbook cobre como detectar, recuperar e prevenir.

## 1. O aviso apareceu. O que fazer?

O sistema avisa de três formas quando, em horário comercial, algo está errado:
- faixa vermelha no topo do painel (somente owner/admin), consultando `GET /organizations/:id/health` a cada 60 s;
- WhatsApp para o número configurado em Configurações > "Alertas do sistema" (campo `health_alert_phone`, com DDI, ex.: 5562999998888; no máximo 1 aviso a cada 2 h por motivo, e 1 mensagem "normalizado" ao voltar durante o expediente). Esse número é separado do telefone de notificação de handoff, que não é usado aqui. Vazio: só a faixa no painel;
- consulta direta: `GET /organizations/:id/health` (campos `status`, `reasons`, `redis`, `evolution`, `lastCustomerMessageAt`).

Motivos possíveis:
| Motivo | Significado | Ação |
|---|---|---|
| Sem mensagens de clientes há X h | Nenhuma mensagem de cliente entrou, e nos 7 dias anteriores essa faixa de horário costumava ter | Verifique os outros dois motivos; confira o WhatsApp do número conectado (chegam mensagens lá?) |
| Redis fora do ar ou lento | `ping` falhou ou passou de 3 s | Passo 3 (reiniciar Redis e worker) |
| WhatsApp (Evolution) desconectado / sem resposta | Instância não está `open`, ou a consulta falhou | EasyPanel > Evolution: veja logs; Instâncias no painel > reconectar (QR code) se preciso |

O alerta só dispara em horário comercial da organização (calendário em `settings.business_calendar`, padrão seg-sex 8h-18h, America/Sao_Paulo).

## 2. Recuperar as mensagens que a Evolution guardou

1. Painel > Configurações > cartão "Recuperar mensagens perdidas" (só owner/admin).
2. Informe De/Até (padrão: últimas 24 h; máximo 7 dias) e clique "Verificar". Isso NÃO altera nada (dryRun). Aparece "X mensagens de Y clientes não chegaram ao CRM". Depois de verificar, as datas ficam travadas: "Recuperar agora" roda exatamente a janela verificada (use "Alterar janela" para mudar).
3. Confira os números e clique "Recuperar agora" e confirme. A IA vai responder esses clientes agora (atrasada). As mensagens mantêm o horário original em `created_at`.
4. A recuperação roda em segundo plano (a API responde 202 com `runId`). O cartão mostra o progresso (feito/total, falhas) a cada 3 s e o resumo final; pode fechar a página e voltar, ele retoma. Status via API: `GET /organizations/:id/admin/recover-messages/status`.
5. Pode rodar de novo à vontade: mensagens já gravadas são ignoradas (dedupe por `evolution_message_id`, em lote). Só uma recuperação por vez por organização (409 se já houver uma).

Como o reenvio é feito (e por que):
- Por cliente: todas as mensagens de um cliente são enviadas em sequência (~150 ms), e só depois de ~1,5 s passa para o próximo cliente (ordem da primeira mensagem). Assim a IA responde uma vez por cliente, com o contexto completo, e não várias vezes.
- Se o Redis estiver fora do ar, o reenvio é recusado (503) antes de começar. Cada mensagem tem teto de 30 s; estourou, conta como falha e segue.
- Clientes que já foram respondidos: se existe qualquer mensagem enviada por nós/humano (inclusive pelo celular) na Evolution DEPOIS da última mensagem perdida do cliente, esse cliente é contado como "já respondido" e suas mensagens NÃO são reenviadas por padrão, para a IA não responder de novo algo que um humano já tratou. Essa foi a opção mais segura; elas não entram no histórico do CRM. Se quiser incluí-las mesmo assim, use a API com `"includeAnswered": true`.
- "Salvas, sem resposta nova da IA": se já existe no CRM uma resposta nossa mais recente que o horário original de uma mensagem recuperada, ela é gravada no lugar certo da conversa, mas a IA não a considera pendente (só responde o que veio depois da última resposta). O resultado informa quantas são.

Via API (equivalente): `POST /organizations/:id/admin/recover-messages` com `{ "since": "2026-10-16T23:00:00-03:00", "until": "...", "dryRun": true }`. `dryRun` é `true` por padrão; só `dryRun:false` reenvia. As respostas trazem contagens e os últimos 4 dígitos dos telefones, nunca o texto.

Observações:
- Grupos e reações/exclusões são ignorados.
- Mensagens de clientes cujo atendimento está com humano (takeover) ou com IA desativada são gravadas, mas a IA não responde, como no fluxo normal.
- Se a janela já passou do que a Evolution guarda (retenção dela), as mensagens não aparecem em "Verificar".
- O cabeçalho interno de replay (que preserva o horário original) só é aceito com um token aleatório gerado a cada subida da API e com `WEBHOOK_SECRET` configurado. Sem `WEBHOOK_SECRET` a recuperação funciona, mas as mensagens ficam com o horário de agora.

## 3. Reiniciar o Redis (e depois o worker)

No EasyPanel:
1. Serviço do Redis > Reiniciar (ou "Implantar"). Aguarde ficar saudável.
2. Em seguida reinicie o serviço do worker (ele perde a conexão e pode ficar parado mesmo com o Redis de volta).
3. Reinicie a API somente se o `/health` seguir mostrando `redis: down` após alguns minutos (a conexão é refeita sozinha, mas é o plano B).
4. Rode a recuperação (passo 2) cobrindo desde o horário da falha.

## 4. Checklist de verificação depois de resolver

- [ ] `GET /organizations/:id/health` retorna `status: "ok"`, `redis: "ok"`, `evolution: "connected"`.
- [ ] Faixa vermelha sumiu (até 60 s) e chegou o WhatsApp "CRM normalizado".
- [ ] Enviar uma mensagem de teste ao número conectado: aparece no CRM e a IA responde.
- [ ] "Verificar" na recuperação cobrindo o período do incidente mostra 0 pendentes.
- [ ] Fila do worker sem jobs acumulados/falhos.

## 5. Configuração recomendada do Redis (EasyPanel, feita manualmente)

O repositório não altera isso; faça no painel:
- **Reinício automático**: no serviço do Redis, política de reinício "sempre" (always / unless-stopped). Se o contêiner morrer, volta sozinho.
- **Persistência com volume**: monte um volume em `/data` e ligue a persistência (`appendonly yes` e/ou `save 60 1000`) para não perder os jobs enfileirados num reinício. Sem volume, reiniciar o Redis apaga a fila.
- **Memória**: defina `maxmemory` com política `noeviction` (BullMQ não tolera evicção de chaves) e monitore o uso; um Redis sem memória é uma causa comum de parada.
- Opcional: alerta de saúde do serviço no EasyPanel como segunda linha, além do monitor da aplicação.

## 6. Como o monitor funciona (para quem mantém)

- Código: `apps/api/src/services/health-monitor.ts` (decisão pura `decideHealth`), rota `apps/api/src/routes/health/index.ts`, recuperação `apps/api/src/routes/admin/recover-messages.ts`.
- Roda em `setInterval` no processo da API a cada 5 min (primeira checagem 30 s após o boot), com estado só em memória. Não usa fila nem Redis para decidir; o `ping` do Redis é apenas uma sonda com timeout de 3 s.
- O aviso por WhatsApp sai direto pela Evolution (não pela fila `send-message`), porque a fila depende do Redis, que pode ser justamente o problema.
- O aviso de silêncio exige média histórica de pelo menos 2 mensagens de clientes na mesma faixa de 2 h (evita alarme em dia fraco). Ao fechar o expediente com um alerta ativo não é enviado "normalizado"; isso só ocorre se normalizar durante o expediente.
- Reiniciar a API zera o anti-spam em memória (um novo aviso pode sair logo após o boot se o problema persistir).
- Migração opcional de desempenho: `supabase/migrations/20261017120000_messages_org_role_created_idx.sql` (`CREATE INDEX CONCURRENTLY`). Rodar manualmente, fora de transação, e não durante uma recuperação de mensagens.
