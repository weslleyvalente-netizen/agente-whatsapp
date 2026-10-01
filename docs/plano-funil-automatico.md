# Funil automático, congelamento e edição completa

Plano aprovado — 01/10/2026. Marina é a vendedora; Mariana é a IA. Implementação local concluída, sem push ou aplicação da migration.

## Problemas confirmados
- Diagnóstico de produção em 01/10: 114 contatos com 170 tarefas abertas sem nenhuma oportunidade (qualquer situação); contagem bruta, não autorização nem número de candidatos automaticamente classificáveis.
- Ronaldo (telefone terminado em 9046421) tem duas tarefas em andamento, mas nenhuma oportunidade. Criar tarefa hoje só vincula a negócio existente; não cria um card.
- O card grande combina oportunidade e qualificação. Editar oportunidade altera somente a primeira: faltam dados do cliente e resumo e os valores de qualificação não pré-preenchem quando o negócio tem campos vazios.
- Data combinada já existe, mas falta um comando único que suspenda as cobranças e garanta uma tarefa futura.

## Comportamento proposto
### Entrada e avanço
1. Mensagem real de cliente cria ou reutiliza um negócio aberto quando a operação estiver identificada com evidência. Anúncio é pista, não decisão definitiva; interesse posterior prevalece. Sem operação clara, contato fica na fila A identificar, sem inventar modalidade. Essa fila é uma apresentação de conversas sem oportunidade, não nova operação comercial.
2. Evolução usa sinais estruturados e evidência da conversa: interesse recebido; qualificação com interesse concreto e informação comercial relevante; proposta/simulação quando condições reais foram apresentadas; decisão/negociação quando cliente avalia ou negocia. Cada operação usa seus estágios existentes. LiberaCred tem estágios próprios.
3. Mensagem genérica não avança. Não inferir proposta de campos preenchidos sem apresentação ao cliente. Não regredir estágio manual, reiniciar negócio encerrado ou escolher entre múltiplos negócios sem contexto claro.
4. Cliente quer fechar/aderir/negociar ou pede consultor: requestHuman obrigatório e coluna Pronto para Marina, preservando etapa comercial.
5. Mudança de operação exige evidência explícita, registro e etapa válida no destino. Ganho/perdido continuam manuais nesta fase.
6. Tudo repetível sem duplicar card/evento, com trava por contato/negócio e escopo de organização. Falha deve aparecer em log, sem impedir resposta ao cliente.

### Congelar
- Botão no card grande para negócio aberto. Modal com calendário de retorno e motivo obrigatório; data futura válida pelo calendário de Brasília.
- Mantém etapa e situação aberta. Selo Congelado até DD/MM e filtro próprio; por padrão separado da fila de ação da Marina. Continua encontrável na busca global.
- Transação única congela o negócio e cria/reagenda uma pendência scheduled_callback vinculada ao negócio, contato e conversa existente. Idempotência contra duplo clique. Não criar tarefa sem concluir congelamento ou congelar sem tarefa.
- Se já há tarefa consolidada, incluir/atualizar a pendência de retorno sem apagar pendências anteriores. Tarefa só termina quando suas pendências terminam. Pendências internas continuam existentes, mas não podem gerar cobrança ao cliente enquanto congelado.
- Antes da data: bloquear geração/envio de follow-up da tarefa, cadências 1h/23h/48h, LiberaCred e geração de tarefas por silêncio/negociação parada. Excluir retornos futuros da visão Hoje e contagem de atrasadas operacionais desse negócio. Revalidar no worker ao enviar para barrar jobs antigos; cancelar somente jobs de follow-up ainda não enviados.
- Envio manual deliberado da Marina na conversa continua disponível; nunca bloquear conversa normal ou mensagens do cliente.
- Na data: retorna à fila de ação com a tarefa vencendo naquele dia; não dispara mensagem, não reinicia automaticamente uma cadência antiga.
- Resposta do cliente antes da data: destacar Cliente respondeu, manter o combinado até Marina descongelar ou confirmar novo plano. Botão Descongelar permite remover só a pendência de retorno criada pelo congelamento, preservando as demais e registrando motivo.
- Mais de um negócio do contato: proteger mensagens automáticas sem vínculo claro; nunca assumir qual negócio o silêncio representa.

### Edição igual ao card grande
- Lápis do card pequeno e Editar dados do card grande levam ao mesmo editor completo, carregado pelo endpoint de detalhes.
- Seções: interesse/condições, resumo/observações/próximo passo, dados do contato, responsável e origem. Campos comerciais do negócio e fallback de qualificação aparecem como no card.
- Campos comerciais editados salvam na oportunidade; dados do cliente/resumo na qualificação da conversa; origem no contato, com endpoints existentes e autenticação. Usar salvamento por seção para evitar sucesso parcial escondido entre tabelas.
- CPF continua protegido: revelação explícita e salvamento pelo fluxo criptografado existente; nunca incluí-lo na busca/listagem geral. Sem conversa, dados comerciais são editáveis e seção de qualificação explica indisponibilidade.
- Mostrar origem do valor quando houver divergência negócio/qualificação. Não copiar valores estimados ou preço antigo para novo plano.

## Migration proposta (não aplicada)
20261001193000_sales_opportunity_freeze.sql, após confirmar histórico remoto:
- opportunities.frozen_until date, freeze_reason text e vínculo/metadata do retorno gerado; constraints para pares válidos e índices apenas se consultas justificarem.
- RPC transacional para congelar/reagendar/descongelar e criar/atualizar tarefa e eventos sob lock; service role restrito, verificação da organização e ator vindos da API, sem permissões públicas adicionais.
- Eventos compatíveis com CHECK existente: examinar antes de adicionar tipos de congelamento/descongelamento; alteração aditiva, down documentado. Nenhuma limpeza/backfill nesta migration.
- Reversão remove função/novos campos e índices, preservando tarefas e eventos gerados. Exportar datas/motivos antes de remoção se houver uso.

## Flags (ausentes = desligadas)
- sales_auto_pipeline_enabled: entrada/avanço automáticos, desligado inicialmente.
- sales_opportunity_freeze_enabled: novo botão e operação de congelamento, desligado inicialmente. Guardas de negócio já congelado continuam protegendo envios se botão for desligado depois.
- Editor completo é correção de interface; não ativa nenhuma automação.

## Arquivos e tarefas de implementação
1. packages/shared/src/sales-pipeline-policy.ts e testes: evidência, etapa por operação, ambiguidade, sem regressão ou fechamento automático; política de congelamento/data em módulo próprio.
2. packages/database/src/queries/opportunities.ts, tasks.ts e wrappers RPC: idempotência, concorrência, eventos e pendências preservadas.
3. apps/api/src/services/opportunity.service.ts e routes/opportunities: congelar/descongelar com autorização, validação e erros; detalhes/editor completo.
4. packages/agent-runtime/src/tools/update-conversation-qualification.ts e request-human.ts; apps/worker/src/workers/process-message.ts: sincronização do funil com evidência real e criação na entrada identificada.
5. apps/worker/src/workers/stale-conversation-followup.ts, low-intent-followup.ts, libera-cred-resumption.ts, send-message.ts e apps/api/src/services/task-followup.service.ts: guardas incluindo fila já agendada.
6. apps/web/src/components/opportunities/opportunity-detail-dialog.tsx, opportunity-edit-dialog.tsx, opportunity-kanban.tsx, app/(dashboard)/opportunities/page.tsx e settings/page.tsx: editor único, calendário/motivo, selo/filtros e A identificar.
7. TDD para regras/RPC/rotas/guardas; testes de datas, duplo clique, falha transacional, pendência consolidada, vários negócios, resposta antes do retorno e job antigo; tipos, build e revisão.
8. Script dry-run de contatos com tarefas sem negócio: classificação com evidência e contagens de candidatos/ambíguos/sem contexto. Mostrar contagens antes de apply; preservar registro histórico e vincular tarefas só com regra inequívoca.
9. Commit local sem push; migration/publicação/ativação em etapas aprovadas, com saúde e teste em contato controlado sem envio a cliente real por iniciativa do assistente.

## Decisões recomendadas para aprovação
D1: congelamento manual até uma data, com tarefa futura; nenhuma mensagem automática na data.
D2: preservar pendências existentes, sem marcá-las concluídas; bloquear apenas cobranças ao cliente até o retorno.
D3: resposta antecipada destaca o card; não descongela silenciosamente.
D4: mesmo editor completo nas duas entradas, salvamento explícito por seção.
D5: automação não cria negócio de operação desconhecida; mostrar A identificar e resolver com evidência posterior.
D6: nenhuma perda/ganho automática ou atualização em lote sem aprovação das contagens.

## Ativação proposta
Primeiro editor completo e congelamento em teste controlado. Depois congelamento manual para operação. Só depois criação/avanço automáticos para leads novos; revisar candidatos antigos e aprovar backfill à parte. Cadência 1h/23h/48h permanece desligada até validar guardas e coordenação desta fase.

## Decisões durante a implementação
- Sincronização centralizada no worker após a qualificação/handoff e após confirmação de envio. As ferramentas simuladas do Playground não executam essa sincronização.
- Proposta exige mensagem de saída confirmada, com valor registrado e prazo, quando aplicável; perguntas de orçamento, condições negadas e estimativas não contam; texto de geração ainda não enviado não avança. Critério conservador: variações sem valor compatível permanecem na etapa atual.
- frozen_at permanece como marca de invalidação após descongelar e protege também jobs antigos da IA que não tinham marca de follow-up. Respostas novas a mensagens do cliente e envio manual deliberado continuam disponíveis.
- Enquanto existir o combinado, cadências antigas continuam pausadas mesmo após a data; a tarefa volta à fila e Marina decide o próximo passo. Descongelar remove a pausa.
- Contatos sem negócio: dry-run em 01/10 encontrou 114 contatos / 171 tarefas, com 55 candidatos preliminares e 59 sem classificação segura. Nenhuma criação em lote aplicada. O script deliberadamente rejeita --apply; a aplicação será preparada somente após revisão/aprovação das contagens e evidências.
- A migration desta fase inclui RPC de sincronização automática além do congelamento: a criação concorrente e os eventos precisam ocorrer sob lock no banco. A função é restrita a service_role, com checagem de organização/mensagem/flag.

## Runbook de publicação (aguardar aprovação)
1. Conferir `supabase migration list`: somente a 20261001193000 desta fase deve estar pendente. Parar se existir outra pendência inesperada.
2. Revisar a 20261001193000 e, após aprovação, executar `supabase db push`. Confirmar os campos e as funções no banco. Migration aditiva; não ativa flags nem faz backfill.
3. Enviar a branch e revisar/mesclar na main somente com autorização. A main dispara deploy automático de API, worker e web no EasyPanel.
4. Conferir os três serviços, saúde da API e mensagens recentes processadas pelo worker. Confirmar `sales_auto_pipeline_enabled` e `sales_opportunity_freeze_enabled` ausentes ou false. Não desligar as flags anteriores já aprovadas.
5. Com flags novas desligadas, validar primeiro o editor pelos dois lápis: mesmos dados, resumo/CPF protegido/origem, salvar seção e conferir card. Testar mensagem manual pelo painel em contato controlado e verificar entrega única, sem mudança indevida de takeover pelo eco.
6. Ativar congelamento primeiro. Em contato controlado, congelar para data futura com CPF pendente: conferir selo, retorno criado uma vez e CPF preservado; repetir/reagendar; verificar que Hoje/atrasadas deixam de cobrar e follow-up fica indisponível. Envio manual da conversa segue permitido.
7. Validar resposta antecipada: Cliente respondeu aparece e data combinada permanece. Descongelar com motivo: callback do congelamento removido e CPF preservado. No retorno, a tarefa reaparece, sem disparo automático.
8. Ativar entrada/avanço automático depois. Novo contato com modalidade identificada gera um único card; oi sozinho fica A identificar; qualificação real avança; proposta só após confirmação do envio; pedido de fechar aparece Pronto para Marina via requestHuman. Testar duplicação/reprocessamento, negócio encerrado e múltiplos negócios sem escolher um deles.
9. Manter cadência 1h/23h/48h desligada até validar a coordenação; acompanhar logs de Pipeline sync failed, erros SQL e follow-ups cancelados por congelamento.
10. Revisar dry-run dos antigos e aprovar candidatos à parte. Não executar --apply em nenhum script nesta publicação.

Rollback: desligar entrada/avanço automático interrompe novas alterações. Desligar congelamento esconde a criação/reagendamento, mas negócios já congelados seguem protegidos e podem ser descongelados. Preferir corrigir código mantendo migration aditiva; rollback para código anterior exige suspender as automações de follow-up, pois ele desconhece o congelamento. Antes de remover campos, exportar datas/motivos e tratar retornos; tarefas/eventos permanecem.

Teste SQL local: instalar @electric-sql/pglite em pasta temporária e executar `node packages/database/scripts/test-sales-freeze-migration.mjs /caminho/temporario/node_modules/@electric-sql/pglite/dist/index.js`. Não usa nem escreve em produção.

Histórico remoto conferido por consulta somente leitura: 00001–00031 e 20260930233509 (sync_published_agent_name). Esta última foi espelhada exatamente no repositório, sem reaplicação. A migration nova recebeu timestamp posterior, 20261001193000, para permitir db push normal sem --include-all ou repair. A CLI Supabase não está disponível no ambiente deste assistente; executar migration list no terminal já usado pelo usuário antes de aplicar. Flags novas confirmadas null/desligadas em produção em 01/10; nenhuma escrita realizada.

## Verificação e registro final
840 testes Vitest: shared 292, database 66, runtime 116, API 246, worker 120. Tipos e build web aprovados. Migration validada em PostgreSQL temporário (PGlite), incluindo idempotência, preservação de CPF/retorno, rollback, autorização/data, avanço confirmado e negócio encerrado. Revisão independente encontrou sete problemas importantes, corrigidos com testes de regressão RED→GREEN; nenhum minor pendente. Não houve envio de mensagem a cliente, push, migration aplicada ou flag ativada.

Registro das decisões (e limitações de validação):
- o plano está em tarefas numeradas descritivas; manter ledger manual com testes por tarefa, sem extrator de briefs — não há blocos Task/Expected para o script.
- centralizar sincronização no worker — preserva simulação Playground e só considera proposta confirmada — custo: avanço aparece após o worker confirmar envio.
- pausar cadência até descongelamento explícito — evita reativar cobranças antigas ao chegar a data — custo: Marina precisa iniciar o retorno pela tarefa.
- aplicar backfill apenas em etapa posterior aprovada — script somente leitura rejeita apply — custo: cards históricos ainda precisam de revisão.
- espelhar migration já aplicada e dar timestamp posterior à nova — histórico remoto tem 20260930233509 e numeração 00032 ficaria anterior — custo: arquivo novo usa 20261001193000 em vez do nome proposto. Nenhuma reaplicação de produção.
- estado remoto conferido via connector readonly — CLI não instalada, migration list final fica no runbook — custo: conferência CLI antes de aplicar ainda necessária.
- entrega Evolution não validada ao vivo — publicação não autorizada e não enviar a clientes reais — custo: teste controlado após deploy permanece necessário.
- contagens dry-run verificadas por leitura REST e classificação local — candidatos ainda sujeitos à revisão — custo: nenhum backfill entregue sem aprovação.
- atualizar a guarda estática dos campos publicados para incluir a migration espelhada — produção já publica name junto com seis campos, sem escrita direta nova — custo: teste reconhece duas migrations explícitas e valida sete campos na mais recente.
