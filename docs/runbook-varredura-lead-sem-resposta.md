# Varredura de cliente sem resposta

## O que faz
A cada 5 minutos o worker (`unanswered-lead-sweep`) procura conversas em que a última mensagem é do cliente, tem entre 10 minutos e 24 horas e não tem nenhuma resposta nossa (IA, humano ou sistema) depois dela. Caso típico: o job `process-message` se perdeu num deploy ou reinício.

## Quais mensagens podem ser reenviadas à IA
Somente mensagens que **o webhook realmente encaminhou à IA** (`messages.metadata.ai_routed_at`, gravado antes de enfileirar) e que **o pipeline da IA nunca terminou de tratar** (`metadata.ai_processed_at` ausente). O `process-message` grava `ai_processed_at` em toda saída normal: resposta enviada, silêncio deliberado ("ok, obrigado"), só ferramentas, agente inativo, IA desativada. Se o job der exceção, não grava, e a varredura enxerga a mensagem.
- Mensagem sem `ai_routed_at` **nunca** é reenviada: takeover liberado depois, IA reativada depois, modo noite, mensagens anteriores a este deploy (não têm marca, então não são reenviadas; vale só para mensagens novas).

## Passos
1. **Retry** (somente mensagens de até 2 h; ligar a flag depois nunca faz a IA responder um backlog velho. Mensagens roteadas e não tratadas entre 2 h e 24 h vão direto ao resumo humano, sem IA): reenfileira o mesmo `process-message` do webhook (mesmo agrupamento de 6 s), uma vez por mensagem, no máximo 10 por varredura, a qualquer hora (a IA responde a qualquer hora). Depois do `queue.add` confere se o job existe; se o BullMQ descartou (deduplicação apontando para job inexistente), não conta como retry, apaga a chave e tenta de novo na próxima varredura (máx. 3 tentativas; depois segue para o aviso).
2. **Aviso em dois estágios** (15 min após o retry, ou 25 min após a mensagem nas conversas com humano, sem resposta; só em horário comercial, fora dele o aviso espera):
   - **Estágio 1, ao vendedor dono da conversa (`conversations.assigned_to`) por push**: "Cliente sem resposta: <nome> (<trecho>)", com idempotência por mensagem (`push_notification_log`, chave `unanswered:<messageId>`). Vale quando a organização tem `push_notifications_enabled`, o dono ainda é membro, tem assinatura push ativa e o servidor tem as chaves VAPID. Nesse caso o dono da loja **não** recebe WhatsApp agora; a chave `unanswered-sweep:alerted:<messageId>` guarda o valor `push:<data>`. Push com erro ou sem nenhum aparelho entregue libera as chaves (sem aparelho, cai no resumo abaixo na mesma varredura).
   - **Fallback imediato** (sem dono, dono sem assinatura, ou push desligado): **um resumo por organização por varredura** (até 5 leads: nome, final do telefone, minutos de espera, trecho; "+N outros"; "N leads com mais de 24 h sem resposta") para `settings.health_alert_phone`, direto pela Evolution, como antes. As chaves de aviso são gravadas **antes** do envio, só para um timeout/erro de rede da Evolution (que pode ter entregado) não repetir o aviso. Qualquer falha anterior à requisição HTTP (banco, sem instância ativa, variável de ambiente ausente, erro ao montar o texto) ou erro HTTP definitivo libera as chaves, e a próxima varredura avisa de novo.
   - **Estágio 2, ao dono da loja aos 60 min**: se o estágio 1 foi por push e a mensagem continua sem resposta aos 60 min de idade (mesmas checagens, e só em expediente), sai o mesmo resumo por WhatsApp, uma única vez por mensagem (chave `unanswered-sweep:alerted-owner:<messageId>`, 24 h; mesma regra de liberar em falha definitiva). O resumo reúne fallback e estágio 2 da mesma varredura.
3. Conversas com atendimento humano (takeover) ou handoff aberto: nunca recebem retry da IA; entram no resumo após 25 min se o humano não respondeu mesmo que a IA já tenha marcado a mensagem como tratada (a marca `ai_processed_at` não suprime o aviso humano). Nunca há aviso duplicado para a mesma mensagem (mesma chave).
4. São puladas: contato ignorado, IA desativada, oportunidade congelada, mensagem sem texto e sem mídia, **mensagem de texto que é só encerramento/adiamento do cliente** (`acknowledgement`: "ok", "obrigado", "blz", joinha, "amanhã eu pego", "mais tarde eu ligo"; até 60 caracteres e 8 palavras; saudações como "boa tarde", perguntas com "?", telefone, valor em dinheiro e mídia nunca são filtrados), mensagens com mais de 24 h (só entram como contagem no resumo, dentro de 7 dias).

O webhook ignora (`no_store`) apenas o **eco de saída** (`fromMe`) dirigido a `health_alert_phone` e `handoff_notification_phone` (os avisos que o próprio sistema enviou; compara DDD + 8 últimos dígitos, tolerando o 9º dígito), com uma linha de log `internal_notification_echo` (org, final do telefone, sem texto). Mensagens recebidas desses números seguem o fluxo normal (o dono pode testar a IA). Os carimbos `ai_routed_at`/`ai_processed_at` têm teto de 2 s para nunca atrasar o atendimento.

## Idempotência
Trava por conversa, reconferência de resposta sob a trava, chaves Redis `unanswered-sweep:retried:<messageId>`, `unanswered-sweep:alerted:<messageId>` e `unanswered-sweep:attempts:<messageId>` (24 h) e jobId `unanswered-sweep-<messageId>`.

## Ligar / desligar
Configurações > Distribuição > "Reenviar à IA e avisar quando um cliente fica sem resposta" (`organizations.settings.unanswered_lead_sweep_enabled`, só gestores). Desligado por padrão. Configure antes o telefone de alertas (`health_alert_phone`); sem ele só o retry funciona (o painel mostra um aviso). Desligar vale na próxima varredura. Sem Redis pronto, a varredura não faz nada.

## Ler os logs
Uma linha por execução (`alerted` = itens em resumo WhatsApp; `pushed` = push ao vendedor):
`unanswered-sweep: orgs=1 candidates=4 retried=1 alerted=0 pushed=0 errors=0 skipped={"answered":2,"too_recent":1}`
Motivos de skipped: too_recent, too_old, answered, ai_processed, not_ai_routed, ignored, ai_disabled, frozen, no_content, human_pending, retry_pending, already_alerted, already_retried, outside_business_hours, acknowledgement, retry_cap, lock_busy, no_agent, no_alert_phone, enqueue_dropped. Linhas de erro trazem conversa e mensagem (`conv <id> msg <id>`) e o motivo, sem telefones.

## Refazer um retry manualmente
Apague no Redis `unanswered-sweep:retried:<messageId>` **e** `unanswered-sweep:attempts:<messageId>`, e remova da fila `process-message` o job `unanswered-sweep-<messageId>` (jobs concluídos/falhos ficam retidos e o BullMQ ignora um jobId repetido). Para reavisar, apague também `unanswered-sweep:alerted:<messageId>`, `unanswered-sweep:alerted-owner:<messageId>` e (push) a linha `unanswered:<messageId>` de `push_notification_log`.

## Painel "Atrasos de resposta"
`listSlaAlerts` (GET `/organizations/:id/lead-assignments/sla-alerts`) não lista mais atribuições já respondidas: aplica em lote a mesma regra de `_alert_assignment_answered` (mensagem `human_agent` desde o handoff, inclusive resposta pelo celular; `first_human_message_at`/`accepted_at`; ligação; atividade comercial; nota; conversa fora de open/waiting; negócio ganho/perdido). Fora da versão TS: eventos humanos de tarefa e de negócio.
