# Runbook: mensagens perdidas e alerta de silêncio

Contexto: em 16-17/10/2026 o Redis ficou parado por ~9 h. A API seguiu no ar, mas a Evolution não conseguiu entregar as mensagens à fila, então nenhum cliente foi respondido. Este runbook cobre como detectar, recuperar e prevenir.

## 1. O aviso apareceu. O que fazer?

O sistema avisa de três formas quando, em horário comercial, algo está errado:
- faixa vermelha no topo do painel (somente owner/admin), consultando `GET /organizations/:id/health` a cada 60 s;
- WhatsApp para o número em Configurações > "Handoff explícito" > telefone de notificação (no máximo 1 aviso a cada 2 h por motivo, e 1 mensagem "normalizado" ao voltar);
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
2. Informe De/Até (padrão: últimas 24 h; máximo 7 dias) e clique "Verificar". Isso NÃO altera nada (dryRun). Aparece "X mensagens de Y clientes não chegaram ao CRM".
3. Confira os números e clique "Recuperar agora" e confirme. A IA vai responder esses clientes agora (atrasada). As mensagens mantêm o horário original em `created_at`.
4. Pode rodar de novo à vontade: mensagens já gravadas são ignoradas (dedupe por `evolution_message_id`). O reenvio é sequencial, ~1,5 s por mensagem; janelas grandes demoram (se o navegador der timeout, o servidor continua; rode "Verificar" depois para ver o que restou).

Via API (equivalente): `POST /organizations/:id/admin/recover-messages` com `{ "since": "2026-10-16T23:00:00-03:00", "until": "...", "dryRun": true }`. `dryRun` é `true` por padrão; só `dryRun:false` reenvia. A resposta traz contagens e os últimos 4 dígitos dos telefones, nunca o texto.

Observações:
- Grupos e reações/exclusões são ignorados.
- Mensagens de clientes cujo atendimento está com humano (takeover) ou com IA desativada são gravadas, mas a IA não responde, como no fluxo normal.
- Se a janela já passou do que a Evolution guarda (retenção dela), as mensagens não aparecem em "Verificar".

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
- Reiniciar a API zera o anti-spam em memória (um novo aviso pode sair logo após o boot se o problema persistir).
- Migração opcional de desempenho: `supabase/migrations/20261017120000_messages_org_role_created_idx.sql` (índice em `messages(organization_id, role, created_at desc)`); aplicar manualmente em produção quando conveniente.
