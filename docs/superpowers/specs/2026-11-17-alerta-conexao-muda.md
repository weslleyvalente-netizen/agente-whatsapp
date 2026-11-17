# Alerta de "conexão muda" (proposta — sem merge nem deploy, desligado por padrão)

## Problema (17/11/2026)
A Evolution ficou `open`/"Connected" e aceitando envios, mas parou de receber mensagens de clientes por ~1h50 em pleno horário comercial (12:46–14:33 BRT). Os envios do CRM não geraram recibo (24 de 33 mensagens sem nenhum ack nesse intervalo, contra ~20% normalmente). Ninguém foi avisado: o monitor atual só grava observações e só diferencia `open` de não-`open`.

## O que o alerta faz
- **Diferencia `open` de recebimento funcional:** com a Evolution em `open`, compara a última mensagem de cliente recebida (a mais recente entre o CRM e a Evolution, via `evolution_connection_observations.last_evolution_message_at`) com o volume habitual.
- **Horário comercial e falso positivo:** não há janela fixa. O volume habitual é a mediana das contagens de mensagens de cliente na MESMA hora da semana (BRT) nas últimas 4 semanas. Abaixo de 6 msgs/h não avalia (madrugada, domingo). A decisão é estatística (Poisson): P(zero mensagens em T) = exp(−λT). "Suspeito" a P < 2% (só vira evidência, não notifica); "mudo" a P < 0,1% e silêncio ≥ 20 min. Com 40 msgs/h, 20 min já é alerta; com 10 msgs/h, só aos ~45 min.
- **Canal independente do WhatsApp afetado:** push (PWA) aos gestores (owner/admin) pela infraestrutura já existente. Não usa WhatsApp. Se um gestor não tem assinatura push, nada chega a ele: o alerta continua gravado (e deve aparecer no banner de saúde numa 2ª etapa).
- **Evidências e sem repetição:** tabela `silent_connection_alerts` (um alerta ABERTO por instância, índice único parcial), com `evidence` só de estados/horários/números agregados (nunca conteúdo, telefone ou chave). Repete no máximo a cada 60 min; resolve sozinho quando voltar a receber. Falha no push não apaga a evidência nem causa reenvio em loop.
- **Fora de escopo e não incluído:** verificação ativa com mensagem externa controlada (exige um segundo número e autorização específica de envio); banner no CRM; qualquer ação sobre a Evolution (reiniciar, reconectar). Estado `close/connecting` continua com o monitor existente.

## Ativação (futura, com autorização)
1. Aplicar a migração `20261117180000_silent_connection_alerts.sql` (cria só a tabela; rollback `DROP TABLE`).
2. `organizations.settings.silent_connection_alert_enabled = true` (ausente = desligado). `SILENT_CONNECTION_ALERT_DISABLED=1` desliga até o timer. Requer `evolution_monitor_enabled` ligado (já está) e VAPID configurado.
3. Antes de ligar: rodar em sombra (apenas logar) por alguns dias úteis para calibrar os limiares (suspeitos/mudos) contra o histórico.

## Testes
- Núcleo puro (`packages/shared/src/silent-connection.test.ts`, 15): caso de 17/11, volume baixo, sem histórico, estados não-`open`, limiares, dedupe, hora da semana em BRT.
- Serviço (`apps/api/src/services/silent-connection-alert.test.ts`, 10): abre uma vez com evidência, mais recente CRM×Evolution, não repete/repete, resolve, volume baixo, `close`, monitor desatualizado, flag ausente, falha no push, erro isolado por instância.

## Limitações conhecidas
- Depende do monitor (observação a cada 5 min); sem observação recente não avalia.
- Mede entrada de mensagens, não a causa. Não substitui capturar os logs do Baileys.
- Volume habitual com 4 semanas pode ser contaminado por quedas passadas (usa a mediana para reduzir).
