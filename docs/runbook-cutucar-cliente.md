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
- Sem dono: `owner_id` vazio e sem `assigned_to`, ou dono que não é mais membro da organização.
- Última mensagem da conversa não é `human_agent` (mensagem da IA não conta como vendedor); mensagem do vendedor com mais de 14 dias.
- Contato congelado; negócio com `waiting_on='scheduled_date'` no futuro ou `waiting_on` = `team`/`bank_or_admin` (pendência nossa).
- Última mensagem do cliente é **recusa explícita** em frase fechada ("sem interesse", "não tenho (mais) interesse", "desisti", "já comprei/fechei/resolvi", "não quero mais", "não vou (mais) comprar/fechar", "pode encerrar/cancelar"). "ok", "obrigado" e similares NÃO impedem o cutucar: cliente que agradece, recebe a proposta e some deve ser cutucado.
- Já existe tarefa `customer_nudge` aberta no mesmo **negócio** (ou no mesmo contato, se a tarefa não tem negócio), em qualquer conversa.
- Organização com `task_consolidation_by_opportunity_enabled` ligada: o worker pula a organização inteira e registra no log (a consolidação funde tarefas e quebraria a contagem de toques). Está desligada em produção; se for ligar, o cutucar precisa ser revisto antes.

## Contato com vários negócios abertos
O worker escolhe um só: o que tem dono e, entre eles, o de interação mais recente. Dono, `waiting_on` e `opportunity_id` da tarefa vêm desse negócio; não nasce uma tarefa por negócio.

## Resolução automática
A cada execução, tarefas abertas `customer_nudge` são concluídas com nota quando o vendedor mandou mensagem depois da tarefa ou o negócio deixou de estar aberto. Mensagem só da IA (`agent`) depois da tarefa **não** resolve o cutucar: só mensagem do vendedor (`human_agent`) ou fim do negócio aberto. Quando o cliente responde, o hook `resolveUnresponsiveTasksOnReply` conclui a tarefa.

## Chave e como desligar
`organizations.settings.customer_nudge_enabled` (padrão desligado; só `true` liga). Em **Configurações > Distribuição** (só gerente): "Lembrar o vendedor de cutucar cliente que parou de responder". Desligar para a criação na próxima execução; as tarefas já criadas ficam abertas (conclua ou cancele em Tarefas se precisar). Push ao vendedor segue `push_notifications_enabled`.

## Se criar tarefa demais
1. Desligue a chave (acima).
2. Teto de segurança: no máximo 25 tarefas novas por organização por execução, só conversas com mensagem do vendedor de até 14 dias.
3. Limpeza: cancele as tarefas `type='customer_nudge'` abertas da organização (status `cancelled`); não há migration nem dado a reverter.
4. Diagnóstico: o log `customer-nudge: orgs=... created=... skipped={...}` mostra por que cada conversa foi pulada.
