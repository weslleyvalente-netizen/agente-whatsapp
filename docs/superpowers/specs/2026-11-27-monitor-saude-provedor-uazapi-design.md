# Monitor de saúde do provedor (UAZAPI): fase B do plano de estabilização

Data: 27/11/2026. Plano aprovado pelo dono em 26/11: o monitor da UAZAPI vem antes do #125, primeiro em modo sombra.

## Problema
- **`evolution-monitor`:** observa a Evolution, que não recebe nada desde a virada para a UAZAPI em 20/11.
- **Alerta de "conexão muda":**
  - é estatístico (silêncio comparado ao movimento habitual) e não distingue pouco movimento de falha: em 24/11 abriu 8 alertas no mesmo dia;
  - usa o horário mais recente entre o CRM e o provedor, então **mascara** o caso "o provedor recebeu e o webhook não entregou";
  - não fechava à noite: com pouco movimento na hora, a avaliação dava "não aplicável", e isso não resolve o alerta. Caso real: o alerta aberto em 26/11 às 17:53 continuava aberto às 19h, com mensagens chegando.
- **Pontos sem medição:** webhook parado, fila represada e duração da falha.

## O que muda
1. **Correção do fechamento.** Em `evaluateSilentConnection`, uma mensagem recente (abaixo do silêncio mínimo) é "ok" em qualquer hora, antes do filtro de movimento habitual. Silêncio longo em hora de pouco movimento continua sem alertar.
2. **Condições diretas novas** (`packages/shared/src/provider-health.ts`, funções puras):

   | Condição | Quando é problema |
   |---|---|
   | `provider_disconnected` | `/instance/status` da UAZAPI diferente de `connected` |
   | `provider_ahead` | a UAZAPI tem mensagem de cliente mais nova que a última do CRM, passados 3 min para o webhook entregar e com 3 min de tolerância |
   | `webhook_stalled` | o CRM enviou mensagens (com id do WhatsApp) há 5 min ou mais e nenhum evento autenticado do webhook chegou desde o envio. Detecta a falha mesmo com pouco movimento, porque as confirmações de entrega e leitura dos nossos envios voltam pelo webhook. |
   | `queue_backlog` | job da fila `process-message` pronto para rodar há mais de 5 min (uma vez por organização, `instance_name = '*'`) |

   O status "desconhecido" (consulta falhou, ou a API acabou de reiniciar e o pulso em memória está vazio) nunca abre nem fecha alerta.
3. **Pulso do webhook** (`webhook-pulse.ts`): o webhook da UAZAPI registra em memória o horário do último evento autenticado por instância. Tem o mesmo processo que roda o monitor, e uma réplica.
4. **Serviço** `provider-health-monitor.ts`:
   - ciclo de 5 min, só para instâncias com `provider='uazapi'`;
   - grava em `silent_connection_alerts` (mesma trava de um alerta aberto por instância, tipo e modo);
   - repete o aviso no máximo a cada 60 min;
   - ao fechar um alerta, registra quanto tempo durou;
   - a evidência inclui se a recuperação automática (`auto_recover_messages_enabled`) estava ligada.
5. **`/health`:** passa a mostrar `monitors.providerHealth` (ciclos, saúde do último ciclo e estado de cada condição, sem dados de cliente).
6. **Migração `20261127120000_provider_health_alert_kinds.sql`:** só amplia a CHECK de `kind`. Rollback no cabeçalho.

## Modo e implantação
- **Chave:** `settings.provider_health_monitor_mode` = `off` (padrão/ausente) | `shadow` | `on`.
- **`off`:** não consulta a UAZAPI nem grava nada.
- **`shadow`:** grava com `mode='shadow'` e não notifica.
- **`on`:** grava e avisa os gestores por push.
- **Desligamento total:** `PROVIDER_HEALTH_MONITOR_DISABLED=1`.
- **Ordem, cada passo com autorização:** migração → merge/deploy (o monitor nasce em `off`) → `shadow` por alguns dias úteis, comparando com o alerta atual → `on`.

## Fora deste PR
- Reconexão automática ou qualquer ação na UAZAPI (o monitor só observa e avisa).
- A recuperação de mensagens continua no `auto-recover` (#119).
- A contagem de mensagens recuperadas por incidente fica para depois, se a sombra mostrar necessidade.
