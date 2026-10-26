# Varredura de cliente sem resposta

## O que faz
A cada 5 minutos o worker (`unanswered-lead-sweep`) procura conversas em que a última mensagem é do cliente, tem entre 10 minutos e 6 horas e não tem nenhuma resposta nossa (IA, humano ou sistema) depois dela. Caso típico: o job `process-message` se perdeu num deploy ou reinício.

1. **Retry**: reenfileira o mesmo processamento do webhook (`process-message`, mesmo agrupamento de 6 s). A IA responde como se a mensagem tivesse acabado de chegar. Uma vez por mensagem, no máximo 10 por varredura.
2. **Aviso**: 15 minutos depois do retry, se ainda não houver resposta, manda UM WhatsApp para `settings.health_alert_phone` direto pela Evolution (sem fila): "Lead sem resposta há N min: nome telefone (último contato: ...). Abra o CRM e responda." Só dentro do horário comercial; fora dele o aviso espera a próxima varredura dentro do expediente (enquanto a mensagem tiver menos de 6 h).

Conversas em atendimento humano (takeover) ou com handoff aberto nunca recebem retry da IA; recebem só o aviso, 25 minutos após a mensagem. São puladas: contato ignorado, IA desativada, oportunidade congelada, mensagem sem texto e sem mídia, mensagens com mais de 6 h (aparecem só no resumo como `too_old`).

## Idempotência
Trava por conversa (a mesma dos outros workers), reconferência de resposta sob a trava, chaves Redis `unanswered-sweep:retried:<messageId>` e `unanswered-sweep:alerted:<messageId>` (SET NX, 24 h) e jobId determinístico `unanswered-sweep-<messageId>`. Se o enfileiramento ou o envio falhar, a chave é apagada para a próxima varredura tentar de novo.

## Ligar / desligar
Configurações > Distribuição > "Reenviar à IA e avisar quando um cliente fica sem resposta" (`organizations.settings.unanswered_lead_sweep_enabled`). Desligado por padrão; só organizações com `true` são varridas. Desligar vale na próxima varredura (até 5 min). Sem Redis pronto, a varredura não faz nada.

## Ler os logs
Uma linha por execução:
`unanswered-sweep: orgs=1 candidates=4 retried=1 alerted=0 errors=0 skipped={"answered":2,"too_recent":1}`
Motivos de skipped: too_recent, too_old, answered, ignored, ai_disabled, frozen, no_content, human_pending, retry_pending, already_alerted, already_retried, outside_business_hours, retry_cap, lock_busy, no_agent, no_alert_phone. Linhas `retried message ... phone ***1234` mostram só os 4 últimos dígitos. `errors>0` traz uma linha `ERR` por conversa (sem dados do cliente).
Para refazer um retry manualmente: apague a chave `unanswered-sweep:retried:<messageId>` no Redis.
