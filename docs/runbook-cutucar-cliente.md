# Runbook: Cutucar cliente

## O que faz
Quando o **vendedor falou por último** (proposta, simulação...) e o cliente sumiu, cria a tarefa **"Cutucar cliente"** (`customer_nudge`) para o vendedor dono do negócio aberto (`opportunities.owner_id`, ou `conversations.assigned_to` se o negócio não tiver dono). Negócio sem dono não gera tarefa (já existe a fila "sem dono"). A IA não manda nada ao cliente: quem cutuca é o vendedor.

No funil, a tarefa aparece em **Compromissos de hoje** (vencida ou de hoje) até o vendedor cutucar ou o cliente responder. Não grava `next_action_due_date` no negócio.

## Escada (minutos úteis do calendário da organização, 1 dia útil = 600 min)
| Toque | Silêncio mínimo desde a última mensagem do vendedor | Prioridade |
|---|---|---|
| 1 | 1 dia útil | normal |
| 2 | 3 dias úteis | normal |
| 3 | 7 dias úteis | alta (sugere encerrar ou marcar como perdido) |

- O número do toque = 1 + tarefas `customer_nudge` já criadas na conversa depois da última mensagem do cliente. Máximo 3; depois para.
- Se o vendedor mandar nova mensagem, o relógio recomeça dela, mas o número do toque continua (só zera quando o cliente responde).
- Só cria dentro do horário comercial (`business_calendar`), com `due_date` = hoje. Roda a cada 30 min.

## Quando NÃO cria
Sem dono; última mensagem não é `human_agent` (mensagem da IA não conta); mensagem do vendedor com mais de 14 dias; contato congelado; negócio com `waiting_on='scheduled_date'` no futuro ou `waiting_on` = `team`/`bank_or_admin` (pendência nossa); última mensagem do cliente é encerramento, agradecimento ou recusa; já existe tarefa `customer_nudge` aberta na conversa.

## Resolução automática
A cada execução, tarefas abertas `customer_nudge` são concluídas com nota quando o vendedor mandou mensagem depois da tarefa ou o negócio deixou de estar aberto. Quando o cliente responde, o hook `resolveUnresponsiveTasksOnReply` conclui a tarefa.

## Chave e como desligar
`organizations.settings.customer_nudge_enabled` (padrão desligado; só `true` liga). Em **Configurações > Distribuição** (só gerente): "Lembrar o vendedor de cutucar cliente que parou de responder". Desligar para a criação na próxima execução; as tarefas já criadas ficam abertas (conclua ou cancele em Tarefas se precisar). Push ao vendedor segue `push_notifications_enabled`.

## Se criar tarefa demais
1. Desligue a chave (acima).
2. Teto de segurança: no máximo 25 tarefas novas por organização por execução, só conversas com mensagem do vendedor de até 14 dias.
3. Limpeza: cancele as tarefas `type='customer_nudge'` abertas da organização (status `cancelled`); não há migration nem dado a reverter.
4. Diagnóstico: o log `customer-nudge: orgs=... created=... skipped={...}` mostra por que cada conversa foi pulada.
