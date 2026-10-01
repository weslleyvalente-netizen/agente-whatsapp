# Funil operacional da Marina

Marina é a vendedora; Mariana é a IA. Plano aprovado em 01/10/2026.

## Bloco 1
- Flag `sales_workspace_enabled` ausente/false: desligada. Sem migration.
- Coluna operacional Pronto para Marina, derivada de handoff request_human sem resposta humana. Preserva estágio comercial. Vários negócios abertos do contato: indicador, sem escolher qual mover.
- Cards: intenção comercial explícita (quente), atendimento humano pendente, última mensagem do cliente e tarefas abertas; mais novos primeiro.
- Card grande com conversa lateral e tarefas executáveis: reutilizar ChatPanel e TaskDetailPanel; preservar envio manual com takeover e follow-up sem takeover conforme configuração existente.
- Atualização periódica; consultas em lote isoladas por organização.

## Tarefa a tarefa
1. Testes de classificação, ambiguidade e ordenação.
2. Serviço de indicadores e autorização/flag.
3. Coluna operacional e indicadores.
4. Conversa lateral e execução de tarefas.
5. Suíte completa, tipos, build e commit local sem push.

## Próximos blocos
Retornos priorizados e cadência coordenada com perda automática 48h após terceiro envio confirmado, excluindo retornos futuros, pendências internas e fechamento. Mostrar contagens antes de ativar; automação desligada por padrão.

## Publicação
Revisar branch; publicar somente com autorização. Este bloco não altera schema. Verificar saúde; flag permanece desligada. Validar: handoff entra, resposta humana retira, vários negócios não são movidos por suposição, conversa envia com takeover e tarefa respeita configuração sem takeover. Ativar em produção só após autorização. Rollback: desligar sales_workspace_enabled; mensagens já enviadas permanecem registradas.

## Ajuste aprovado: leads sem intenção de avanço
Retornos em 1h e 23h; mensagem final em 48h após o atendimento inicial, sem tarefa humana por silêncio. Texto acolhedor, sem afirmar perda definitiva. Retomar normalmente se cliente responder. Registro na mensagem, sem depender de task_events. Flag própria desligada; excluir handoffs, negócios avançados e pendências internas/agendadas.

## Implementado na branch (sem publicação)
- Coluna operacional e indicadores derivados de handoff; etapas comerciais preservadas.
- Conversa lateral com envio manual e tarefas executáveis dentro do negócio.
- sales_low_intent_cadence_enabled: retornos em 1h/23h e mensagem final em 48h. Usa messages.metadata, sem criar tarefas de silêncio. Elegível somente sem handoff/tarefa aberta, sem negócio avançado/valor conhecido e sem pendência interna/agendada. Texto fixo sem ofertas ou valores.
- Ativação salva sales_low_intent_cadence_started_at: apenas atendimentos iniciais posteriores entram, não contatos antigos. Cadência exige confirmação Evolution para avançar; tentativa pendente não é reenviada automaticamente (attempts: 1). Horário comercial do agente permanece respeitado; scheduler de 15min pode atrasar o envio.
- Intervalo e teto da nova cadência por instância: reserva atômica em Redis usando valores configurados task_followup_min_interval_seconds/daily_limit (45s/40 por padrão). Contador dessa cadência é separado do painel; não representa um teto global combinado. Unificação dos contadores entra no próximo bloco de coordenação.
- Encerramento termina apenas os toques automáticos. Conversa e negócio permanecem disponíveis para retomada; não há perda automática neste bloco.
- Retornos automáticos confirmados entram na contagem de toques do follow-up humano.
- Caso Andreia: áudio human_agent estava [audio]. Transcrição sob demanda de até 3 áudios recentes, no máximo 5min cada; salva texto e audio_transcribed_at, invalida sugestão anterior e respeita limite de regenerações. Falha mostra erro e permite mensagem manual; sem gerar ignorando áudio. Histórico da atendente prevalece sobre tarefa antiga no prompt. Nenhuma transcrição em lote ou alteração desse contato foi feita em produção.

## Runbook detalhado
1. Revisar commit local e publicar branch/merge só após autorização. Não há migration neste bloco.
2. Deploy automático dos serviços API/web/worker; conferir saúde e logs. As duas flags novas devem permanecer ausentes/false.
3. Testar regressão sem flags: enviar UMA mensagem manual em contato de teste, conferir recebimento único e takeover; tarefa continua com envio confirmado antes da conclusão.
4. Ativar apenas sales_workspace_enabled em Configurações > Operação no funil de vendas. Conferir card quente, coluna Pronto para Marina e etapa comercial preservada; contatos com mais de um negócio não são movidos por suposição. Resposta humana retira da coluna em até 30s.
5. Abrir card: enviar mensagem manual no chat lateral (assume atendimento), executar tarefa sem takeover conforme configuração, concluir/reagendar e conferir contagem; confirmar que atualização periódica não fecha o card.
6. Em contato de teste com áudio da atendente, gerar sugestão: texto transcrito deve entrar no histórico; abrir outra vez não transcreve de novo. Se arquivo indisponível, erro claro e edição manual, sem texto inventado.
7. Só após essas validações, ativar sales_low_intent_cadence_enabled, que salva horário de início. Novos leads elegíveis: 1h, 23h, final48h; sem tarefa nova para Marina. Cliente respondeu/assumido/negociação avançou: automação para. Envio não confirmado impede próxima etapa. Limite da instância pausa a cadência; sem rajada de mensagens atrasadas.
8. Rollback: desligar as duas flags. A transcrição sob demanda é correção no envio de tarefas já existente; caso dê problema, reverter o commit e republicar serviços. Desligar task_followup_enabled temporariamente interrompe geração/envio por tarefas; envios já feitos permanecem registrados.

## Pendente, explicitamente fora deste bloco
Perda automática/reabertura, fila de retornos priorizada, teto global combinado painel+cadência e revisão das tarefas antigas com contagens antes de qualquer limpeza.

## Verificação local
802 testes passaram: API243, worker116, shared267, database60, agent-runtime116. Tipos de API/web/worker e build de produção web passaram. Na execução paralela, dois testes antigos tiveram timeout (agent-config/images upload e search-catalog formatVehicleList); repetição integral das duas suítes com menos concorrência passou, sem alterar esses testes. Uma execução inicial pela raiz incluiu worktrees arquivados e detectou teste de data antigo em helena-ia-crm-setembro/apps/api/src/routes/costs/index.test.ts; os worktrees arquivados não foram alterados e a suíte do projeto atual passou.
Validação visual e de envio em ambiente implantado ainda deverá seguir o runbook. Não houve push, migration, ativação de flag ou mensagem enviada em produção.

## Ajustes após revisão independente
Cadência executada antes da condição do follow-up antigo, com seleção própria de 1h e exclusão do fluxo antigo para contatos tratados. Ganhos/perdidos sem outro negócio aberto não recebem mensagem. Falha de transcrição limpa sugestão antiga antes de habilitar envio manual; cota esgotada com áudio novo também permite escrita manual sem reusar texto antigo. Falha de atualização periódica preserva card e rascunhos.

Tarefas vinculadas somente ao contato também são exibidas, identificadas como sem negócio vinculado; tarefas de outro negócio não entram. Não houve backfill ou modificação dos vínculos.


### Publicação do funil operacional — 01/10/2026
- Autorizada pelo usuário; main atualizada por fast-forward e push a ce1db09, sem conflitos ou migration.
- EasyPanel: worker Success às 14:21:40, API às 14:21:52 e web às 14:23:38 (Brasília). API /health OK após troca dos containers.
- Worker novo iniciou cinco consumidores e processou/enviou resposta real; banco confirmou cinco mensagens de clientes e uma da IA após 14:21:40.
- Controles novos observados na interface implantada; sales_workspace_enabled e sales_low_intent_cadence_enabled continuam ausentes/desligadas. Não houve ativação ou mensagem de teste enviada pelo assistente.
- Correção de contexto de áudio disponível no fluxo existente de sugestões. Validação manual de envio/áudio e da visão nova ainda pendente, conforme runbook. Primeiro ativar somente a visão do funil; cadência fica para depois dessa validação.
