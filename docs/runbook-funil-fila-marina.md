# Funil como fila de trabalho da Marina

Implementação local: `codex/funil-fila-marina`, baseada na main `de71dcb`. Marina é a vendedora; Mariana é a IA. Usa o responsável de handoff configurado; na ausência dele, só usa a conta da organização se houver exatamente um membro. Não cria usuários nem escolhe arbitrariamente entre vendedores.

## Operação

Ao ligar a fila, o Funil abre uma visão de todos os negócios com prioridade: Pronto para Marina, Cliente respondeu, Compromissos de hoje, Pendências com interesse e Próximas ações. Retornos futuros, esperas pelo cliente/banco e Sem resposta ficam separados. Dentro do grupo, prioridade da tarefa, data e criação mais recente desempatam. Todas as pendências consolidadas entram na classificação e na ordenação; cards sem tarefa permanecem visíveis em Próximas ações ou Outros. As etapas comerciais continuam disponíveis em outra visão. Arrastar entre grupos operacionais não muda o estágio comercial.

O card mantém dados, chat e execução da tarefa/follow-up. Tarefas antigas sem negócio aberto são acessíveis no próprio Funil, com silêncio separado; não são excluídas, concluídas ou convertidas em perda. A seleção do painel permanece estável quando a tarefa é concluída e a lista atualiza.

Financiamento: Interesse → Qualificação → Documentação → Aguardando simulação → Análise bancária → Financiamento aprovado / Financiamento reprovado → Formalização. Reprovação é uma alternativa de resultado, não um avanço automático. O resultado e o envio da ficha ao banco exigem registro humano com evidência. Reprovado permanece aberto; para tentar em outra data, use Congelar/agendar retorno. Não há envio ao banco ou decisão automática de crédito.

Aguardando simulação exige modelo, CPF armazenado, nascimento, resposta sobre CNH e entrada (zero é válido), além de requestHuman real e ainda pendente. Não exige informação não necessária, nem expõe CPF em descrição. Um “Ok” posterior não apaga a qualificação. A criação/vínculo do card, tarefa, responsável e eventos acontece na mesma transação, sob lock do contato. Repetição do mesmo handoff não duplica nem recria tarefa concluída. Havendo tarefa aberta, reutiliza e preserva as pendências, maior prioridade e data original; resumo de encaminhamento é acrescentado. Sem tarefa, vence na próxima abertura do horário publicado do agente, padrão 8–18 de Brasília. Fora dessa janela, vai para a abertura seguinte, seguindo os dias corridos do horário existente.

## Levantamento histórico (somente leitura, 01/10/2026)

207 tarefas abertas (pending/in_progress/rescheduled); 147 sem opportunity_id; 71 customer_unresponsive; 143 sem negócio aberto associado. Não confundir ausência de vínculo com ausência de negócio: algumas podem ser exibidas via contato em card existente.

Nenhum apply histórico foi executado. A reorganização visual não altera a prioridade gravada. Criação/vínculo retroativo de cards exige levantamento individual, contagens e aprovação separados. Pedro (62 99963-3412) continua caso de reparo histórico: cadastro pronto para simulação, handoff real, sem card/tarefa no diagnóstico; não é lead sem resposta. Ativar flags não varre o passado automaticamente.

## Migration e flags

Nova migration `20261002024809_sales_marina_queue.sql`: substitui `sync_sales_pipeline` mantendo assinatura e escopo/service_role; aceita o estágio Aguardando simulação, valida dados/encaminhamento reais, protege resultados humanos e preenche apenas valores comerciais que estavam vazios. Nenhuma coluna/tabela nova; não contém atualização histórica. A função só age quando chamada, com automação ligada.

Confirmado por consulta somente leitura: as duas flags novas e sales_auto_pipeline_enabled estão ausentes em produção, portanto desligadas.

- `sales_action_queue_enabled`: visão principal e acesso às tarefas antigas; ausente/false = desligada.
- `sales_qualified_handoff_task_enabled`: criação/consolidação da tarefa qualificada; ausente/false = desligada. Depende de `sales_auto_pipeline_enabled`.
- `sales_workspace_enabled`: visão operacional anterior; pode continuar ligada.
- `sales_opportunity_freeze_enabled`: recurso existente, necessário para agendar/congelar uma nova tentativa.
- `task_followup_enabled`: recurso existente, necessário para enviar e concluir no painel de tarefa.

A migration é funcional e reversível: após desligar as duas automações, restaurar a definição anterior da função contida em `20261001194818_sales_opportunity_freeze.sql` (usar CREATE OR REPLACE). Manter os cards, tarefas e eventos já criados. Estágios novos devem ser reconciliados manualmente antes de restaurar uma versão antiga da interface. Não há down destrutivo automático.

## Publicação concluída em 01/10/2026

Migration aplicada pelo conector Supabase, versão 20261002024809; main publicada em 118aab9. EasyPanel confirmou Success dos três serviços, API saudável e cinco workers iniciados. Controles novos e etapas de financiamento conferidos no CRM. Flags novas e avanço automático permanecem desligados; nenhuma alteração histórica ou mensagem de teste executada. A fila ativada e envio controlado ainda precisam de validação.

Passos de referência:

1. Conferir `git status`, a branch e `supabase migration list`. O histórico anterior deve estar sincronizado; somente a migration nova deste recurso deve estar pendente. Se houver outra, parar e reconciliar a origem antes de aplicar.
2. Após aprovação do usuário, executar `supabase db push`. Confirmar no histórico e consultar `pg_get_functiondef` para a assinatura existente de sync_sales_pipeline. As flags novas continuam desligadas.
3. Fazer push da branch, revisar e integrar na main. Push da main dispara deploy de API/worker/web no EasyPanel.
4. Aguardar Success dos três serviços; conferir `/health`, início e consumo do worker e mensagens recebidas/confirmadas no banco. Não enviar mensagem a cliente como teste.
5. Conferir no banco que as duas flags novas estão ausentes/false. Testar o envio manual anterior em número de teste autorizado: chega uma única vez, eco não ativa takeover indevido, histórico preservado. Validar que as conversas e tarefas existentes continuam abrindo.

## Ativação gradual

1. Ligar só `sales_action_queue_enabled`. Abrir Funil: fila de todos os negócios, grupos e prioridades, duas revisões de tarefas antigas, card com chat e tarefa. Concluir somente uma tarefa de teste; painel não deve sumir. Nenhuma mensagem automática é criada por esta flag.
2. Com migration/deploy confirmados, ligar `sales_auto_pipeline_enabled` (se ainda desligada). Validar um lead de teste: interesse e qualificação avançam com dados reais; proposta depende de mensagem confirmada; negócio ganho/perdido não é recriado. Não há backfill automático.
3. Ligar `sales_qualified_handoff_task_enabled`. Validar um financiamento completo e requestHuman: um card, uma tarefa de simulação, responsável = conta compartilhada, resumo correto. Fora do horário, vencimento na próxima abertura; repetir processamento não duplica. Registro de banco aprovado/reprovado não muda após a IA responder.
4. Se necessário, ligar o congelamento existente e testar uma nova tentativa agendada: data/motivo e tarefa futura, sem contato automático. Manter cadências e perdas automáticas desligadas nesta publicação.
5. Revisar os 143 casos históricos e apresentar contagens antes de qualquer vínculo/criação em lote. A fila antiga permanece acessível no Funil durante essa revisão.

## Rollback

Se a fila tiver problema, desligar `sales_action_queue_enabled`: restaura a visão anterior. Se criar tarefas erradas, desligar `sales_qualified_handoff_task_enabled` e, se necessário, `sales_auto_pipeline_enabled`; parar processamento automático sem excluir tarefas/eventos. Reverter deploy para main anterior apenas após conferir compatibilidade dos novos estágios. Restaurar a função anterior somente se houver problema na migration; não apagar dados como rollback.

## Validação local

TDD: classificação/ordenação da fila, financiamento completo/incompleto, consulta ao handoff real, enriquecimento das tarefas e etapas humanas. 856 testes nas suítes dos cinco pacotes/serviços passaram; queue passou compilação (não possui suíte). Build de produção web passou. Testes SQL em PGlite passaram: repetição/idempotência, flag desligada, dados/encaminhamento reais, resultados humanos preservados, pendências antigas/prioridade/data preservadas e rollback de evento. Logs de erro esperados em testes antigos de falhas simuladas continuam presentes.

Revisão independente encontrou quatro problemas corrigidos com regressões: troca automática de modalidade não apaga resultados bancários; nenhum card aberto some da fila; pendências consolidadas participam da prioridade; painel recarrega após concluir/cancelar. A precedência dos compromissos sobre ações bancárias foi corrigida no recheck; revisão final sem achados importantes pendentes.

Validação visual completa e envio controlado serão feitos depois do deploy; não foram simulados como resultado em produção.

## Ativação realizada — 02/10/2026

Autorizada pelo usuário às 9h20–9h21 Brasília. sales_action_queue_enabled, sales_auto_pipeline_enabled e sales_qualified_handoff_task_enabled confirmadas true. Migrations já aplicadas, sem novo deploy ou migration. Fila conferida em produção; task_followup_enabled e responsável de handoff existentes preservados. Sem backfill, perdas, exclusões ou envio de teste. Cadência contínua permanece desligada; fila histórica aprovada de 03/10 preservada.

21 testes direcionados passaram. Não havia novas entradas após ativação às 9h21:42 para comprovar a criação/avanço em fluxo orgânico. A fila inclui acervo histórico: Cliente respondeu não equivale a resposta de hoje, e Compromissos de hoje inclui datas vencidas. Classificação de pendências que estão somente em texto e saneamento das datas antigas continuam sujeitos à revisão histórica.
