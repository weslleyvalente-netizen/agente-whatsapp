# Alerta de "conexão muda" (proposta v2 — sem merge nem deploy, desligado por padrão)

## Problema (17/11/2026)
A Evolution ficou `open`/"Connected" e aceitando envios, mas parou de receber mensagens de clientes por ~1h50 em pleno horário comercial (12:46–14:33 BRT). Os envios do CRM não geraram recibo (24 de 33 mensagens sem nenhum ack nesse intervalo, contra ~20% normalmente). Ninguém foi avisado: o monitor atual só grava observações e só diferencia `open` de não-`open`.

## O que o alerta faz
- **Diferencia `open` de recebimento funcional:** com a Evolution em `open`, compara a última mensagem de cliente recebida (a mais recente entre o CRM e a Evolution, via `evolution_connection_observations.last_evolution_message_at`) com o volume habitual.
- **Horário comercial e falso positivo:** não há janela fixa. O volume habitual é a mediana das contagens de mensagens de cliente na MESMA hora da semana (BRT) nas últimas 4 semanas. Abaixo de 6 msgs/h não avalia (madrugada, domingo). A decisão é estatística (Poisson): P(zero mensagens em T) = exp(−λT). "Suspeito" a P < 2% (só vira evidência, não notifica); "mudo" a P < 0,1% e silêncio ≥ 20 min. Com 40 msgs/h, 20 min já é alerta; com 10 msgs/h, só aos ~45 min.
- **Canal independente do WhatsApp afetado:** push (PWA) aos gestores (owner/admin) pela infraestrutura já existente. Não usa WhatsApp. Se um gestor não tem assinatura push, nada chega a ele: o alerta continua gravado (e deve aparecer no banner de saúde numa 2ª etapa).
- **Evidências e sem repetição:** tabela `silent_connection_alerts` (um alerta ABERTO por instância, índice único parcial), com `evidence` só de estados/horários/números agregados (nunca conteúdo, telefone ou chave). Repete no máximo a cada 60 min; resolve sozinho quando voltar a receber. Falha no push não apaga a evidência nem causa reenvio em loop.
- **Fora de escopo e não incluído:** verificação ativa com mensagem externa controlada (exige um segundo número e autorização específica de envio); banner no CRM; qualquer ação sobre a Evolution (reiniciar, reconectar). Estado `close/connecting` continua com o monitor existente.

## v2 — o que mudou (revisão de 17/11, tarde)
- **Três modos reais** por organização: `settings.silent_connection_alert_mode` = `off` (padrão; ausente/inválido/booleano antigo = off) | `shadow` | `on`. **Shadow** grava o alerta que seria disparado (`mode='shadow'`, com evidência) e só loga "[SOMBRA] enviaria aviso"; não envia push.
- **Canal comprovado antes de notificar:** `on` só notifica se houver VAPID configurado **e** ao menos um gestor (owner/admin) com assinatura push; senão roda como shadow e registra a condição `push_not_ready` (uma vez; resolve quando houver canal). Falha ao verificar = não pronto.
- **Saúde do próprio monitor** (condição distinta `monitor_blind`): sem observação, observação com mais de 15 min ou consulta à Evolution falhando. Nesses casos não avalia "mudo" nem "tudo bem" e avisa "Monitoramento sem dados". Um alerta de mudez aberto não é resolvido por monitor cego.
- **Sem duplicidade em execuções concorrentes:** quem notifica é quem vence uma gravação atômica: abertura = INSERT com índice único parcial `(organization_id, instance_name, kind, mode) WHERE resolved_at IS NULL`; repetição = UPDATE condicional em `last_notified_at` (só uma linha volta). Testado com dois ciclos em corrida.
- **Monitor externo independente da API (avaliação e o que foi feito):** o alerta roda no mesmo processo da API; se a API ou o timer morrerem, ninguém avisa. Mitigação implementada e opcional: `SILENT_CONNECTION_HEARTBEAT_URL` recebe um GET sem dados a cada ciclo saudável (só se alguma organização usa o alerta); um serviço externo de "heartbeat/dead-man's switch" (ex.: Healthchecks.io, UptimeRobot heartbeat) avisa por e-mail/SMS/Telegram quando os pings param, **fora** do WhatsApp e da API. Recomendado também: uma verificação HTTP externa em `GET /health` da API. Limite: o heartbeat prova que o laço do alerta está vivo, não que mensagens estão chegando; a prova ponta a ponta continua sendo a verificação ativa com mensagem externa controlada (outro número), que exige autorização específica de envio e fica fora deste PR.
- Migração (não aplicada): colunas `kind` e `mode`; índice único com ambos.

## Ativação (futura, com autorização)
1. Aplicar a migração `20261117180000_silent_connection_alerts.sql` (cria só a tabela; rollback `DROP TABLE`).
2. Primeiro `silent_connection_alert_mode = "shadow"` por alguns dias úteis (calibrar: conferir as linhas `mode='shadow'` contra o histórico). Depois `"on"`, somente com pelo menos um gestor com push ativo (senão fica em sombra e registra `push_not_ready`). `SILENT_CONNECTION_ALERT_DISABLED=1` desliga até o timer. Requer `evolution_monitor_enabled` ligado (já está).
3. Opcional: `SILENT_CONNECTION_HEARTBEAT_URL` para o monitor externo.

## Testes
- Núcleo puro (`packages/shared/src/silent-connection.test.ts`, 15): caso de 17/11, volume baixo, sem histórico, estados não-`open`, limiares, dedupe, hora da semana em BRT.
- Serviço (`apps/api/src/services/silent-connection-alert.test.ts`, 10): abre uma vez com evidência, mais recente CRM×Evolution, não repete/repete, resolve, volume baixo, `close`, monitor desatualizado, flag ausente, falha no push, erro isolado por instância.

## Limitações conhecidas
- Depende do monitor (observação a cada 5 min); sem observação recente não avalia.
- Mede entrada de mensagens, não a causa. Não substitui capturar os logs do Baileys.
- Volume habitual com 4 semanas pode ser contaminado por quedas passadas (usa a mediana para reduzir).

## Timeout de 20 s: o que acontece quando a operação original termina depois

`withDeadline` rejeita a chamada após 20 s, mas **não cancela** a operação original (o cliente do banco não aborta). Consequências tratadas e testadas:

| Risco | Tratamento | Teste |
|---|---|---|
| Ciclo lento ultrapassado por outro grava/notifica ao acordar | `isCurrent`: o ciclo ultrapassado não inicia gravação nem push e encerra | "ciclo ultrapassado … leitura obsoleta" (falha sem a guarda) |
| Ciclo ultrapassado emite heartbeat | `isCurrent` também barra o ping | "ciclo vencido … não emite heartbeat" |
| `resolveAlert` atrasado fecha alerta que outro ciclo já renovou | compare-and-set em `last_notified_at` (lido pelo ciclo que decidiu) | "resolveAlert … NÃO fecha alerta que outro ciclo já tocou" |
| Push duplicado | `openAlert` (índice único) e `claimRepeat` (UPDATE condicional) são atômicos; o push só sai de quem venceu a gravação, e uma falha/timeout do push **não** é repetida no ciclo | testes de concorrência e de falha de push |
| Chamadas penduradas se acumulam entre ciclos | contador de "penduradas" (estouraram e ainda não terminaram); com 5, novas chamadas são recusadas na hora; ao terminar, a vaga é liberada | "consultas penduradas não se acumulam" e "libera a vaga" |

### Limites que permanecem (não corrigíveis sem mudar o desenho)
1. **Gravação ambígua** (`openAlert`/`claimRepeat` estoura o timeout mas o banco confirma): o alerta fica gravado com `last_notified_at` atual e **o push daquele ciclo não sai**; o próximo aviso só na repetição (60 min). Não gera duplicado; pode atrasar o primeiro aviso em modo `on`. Em `shadow` não tem efeito.
2. **Push que estoura o timeout** pode chegar atrasado ao celular; não é reenviado (evita duplicado).
3. **`resolveAlert` atrasado de um alerta que ninguém mais tocou** ainda o fecha; se a mudez continua, o ciclo seguinte abre outro alerta e notifica de novo (aviso repetido, não perdido).
4. A consulta pendurada continua no servidor até o próprio timeout do cliente/servidor (a ordem de minutos); o teto de 5 chamadas penduradas limita o empilhamento do lado da API, não a carga que já foi enviada.
5. Heartbeat prova que o **laço** está vivo e sem falha de etapa, não que mensagens chegam (isso exige verificação ativa, fora deste PR).

## Requisitos por modo
**shadow** (só registra o que enviaria; nenhum push): migração `20261117180000` aplicada; deploy desta versão; `silent_connection_alert_mode = "shadow"` na organização; o monitor da Evolution já gravando observações (já ocorre). Não exige gestor com push nem VAPID. Recomendado, não obrigatório: `SILENT_CONNECTION_HEARTBEAT_URL` com um serviço externo.
**on** (notifica): tudo do shadow + VAPID configurado + pelo menos um gestor com push ativo e testado + heartbeat externo configurado + revisão de alguns dias úteis de registros `shadow` sem falso positivo relevante + sua autorização. Sem gestor com push o modo `on` cai sozinho para sombra e registra `push_not_ready`.


## Correção pendente (registrada em 18/11/2026): hora de chegada x hora real da mensagem
O monitor mede o silêncio pela `created_at` da última mensagem de cliente no CRM, que é a hora em que a mensagem CHEGOU. Em 18/11, mensagens atrasadas entregues às 17:45 e a partir das 18:08 UTC
(a Evolution seguia sem registrar mensagem nova desde 16:00:36) zeraram o silêncio e teriam resolvido/escondido o alerta. Um lote antigo recebido agora não deve, sozinho, comprovar que a conexão
voltou a receber mensagens atuais. Direção da correção: usar o instante original (`metadata.wa_original_at`, gravado pelo webhook a partir deste PR) e só contar como "recebendo" mensagem cujo
instante original seja recente; reavaliar também `last_evolution_message_at`. Não implementada; exige PR próprio.
