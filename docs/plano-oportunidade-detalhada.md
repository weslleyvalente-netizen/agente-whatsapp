# Oportunidade detalhada e correção do follow-up

Escopo aprovado em 30/09/2026. Branch `codex/oportunidade-detalhada-followup`.
Sem push, publicação ou aplicação de migration nesta etapa.

1. TDD: reproduzir sugestão repetida após erro de custo, carregamento que consome regeneração e ausência de texto anterior no pedido à IA.
2. Corrigir geração: abrir reutiliza texto salvo; só Gerar outra regenera; falhas visíveis não salvam texto genérico nem consomem cota; enviar texto anterior à IA.
3. Preparar migration 00031 para permitir task_followup_suggestion no CHECK de ai_usage_events.source; manter fontes anteriores; não aplicar sem OK.
4. TDD: endpoint de detalhes com autorização por organização, dados comerciais, contato, qualificação da conversa mais recente, pendências e eventos. CPF oculto por padrão e revelado sob ação explícita do usuário autorizado.
5. Janela central grande ao clicar no card, responsiva, com cabeçalho e etapas; dados comerciais, pessoais, resumo disponível, observações, pendências e histórico.
6. Ações na janela: editar, abrir conversa, mudar etapa com evidência, ganho com confirmação e perda com motivo/evidência obrigatórios. Nada encerra oportunidades automaticamente.
7. Manter arrastar cards, evitando abertura acidental ao arrastar; filtro Em andamento/Ganhos/Perdidos para revisar resultados.
8. Testes dos fluxos alterados, typecheck e build web; suíte completa e relatar qualquer falha pré-existente. Commit local sem push.

Dados ausentes são Não informado. Não gerar resumo retroativo automaticamente nem modificar CPF, tarefas reais ou contagens em produção.
Migration só amplia valores permitidos: sem alteração de linhas. Reversão do CHECK antigo depende de remover/migrar registros com a nova fonte; não fazer automaticamente.
Deploy posterior: aprovar/aplicar 00031 antes do código; deploy API/web; testar geração, reabertura sem gastar cota, erros sem gastar cota, card e mudanças de funil em oportunidade de teste. Worker não precisa mudar.

Origem do lead: preencher por evidência registrada, permitir correção manual sem sobrescrita automática. Wix = formulário do site; externalAdReply = anúncio Facebook/Instagram quando identificável, senão Anúncio Meta; “vim do Instagram” sem anúncio = Instagram orgânico. Preservar a primeira origem identificada e a evidência. Sem backfill em produção nesta etapa.

## Implementação e validação — 30/09/2026

Card ampliado implementado com contato, CPF sob revelação explícita, cidade, nascimento, CNH, modelo/bem, entrada, parcela, prazo, crédito, lance, urgência, objeções, resumo existente, observações, tarefas vinculadas e histórico. Etapas usam evidência; ganho e perda exigem confirmação, perda também exige motivo. Situação do funil permite revisar ganhos/perdidos. Abrir conversa aponta para /inbox?id=.

Origem automática registrada em wa_contacts.metadata.lead_origin, preservando primeira identificação e metadados existentes com compare-and-set. Correção manual disponível no card, identifica usuário/data e não é sobrescrita pelos webhooks. Nenhum backfill de origem realizado. Origem sem evidência permanece não informada.

Gerar outra: requisição explícita regenerate=true, texto anterior no prompt, cache ao abrir, erro visível sem salvar fallback ou incrementar cota; edição pode apagar todo o texto sem perder o campo. Troca de tarefa reinicia o painel.

Validação: suites API, runtime, shared, database e worker; typecheck API/runtime/shared/web e build de produção web. Um teste antigo de custos dependia da data real; relógio fixado no teste, sem alteração da regra do relatório. Validação visual/interativa no ambiente publicado permanece no checklist abaixo.

## Runbook (executado após OK em 30/09/2026)

1. Conferir branch e migrations com `supabase migration list`. A nova migration preparada aqui é 00031_task_followup_usage_source.sql; conferir qualquer outra pendência antes de aplicar.
2. Com OK explícito, executar `supabase db push`. Confirmar ai_usage_events_source_check inclui task_followup_suggestion. Nenhuma coluna/linha é removida; somente uma fonte adicional é permitida.
3. Publicar a branch codex/oportunidade-detalhada-followup e revisar/merge na main pelo processo combinado. O push/merge não foi realizado nesta etapa. Main aciona deploy automático.
4. Conferir saúde API, deploy API/web e chegada de mensagens. Não ativar/desativar flags nesta publicação: follow-up mantém task_followup_enabled existente. Origem entra na ingestão da API; worker usa as mesmas regras anteriores.
5. Validar manualmente: clique abre card; arrastar não abre; campos ausentes ficam não informados; CPF começa oculto; abrir conversa leva ao contato certo; mudar etapa exige evidência; ganho/perda em oportunidade de teste aparecem no filtro correto e no histórico.
6. Validar origem: Wix, anúncio com plataforma conhecida, Meta desconhecida e frase vim do Instagram. Correção manual permanece após nova mensagem. Não criar envios para clientes apenas para validar.
7. Validar sugestões: reabrir conserva texto/cota; Gerar outra modifica abordagem e consome uma regeneração somente no sucesso; falha preserva texto/cota e mostra erro; apagar texto mantém campo editável. Mensagens/sugestões genéricas antigas permanecem até regeneração explícita.
8. Rollback: reverter apenas o commit desta funcionalidade e redeploy API/web, preservando outros commits. Manter CHECK ampliado (compatível com código antigo). Restaurar CHECK antigo só após avaliar os registros com task_followup_suggestion; não apagar custos para permitir rollback.

## Resultado da publicação — 30/09/2026

- Commit 453678e publicado na branch e integrado por fast-forward à main; push da main iniciou o deploy.
- CLI encontrado no cache local. Histórico 00029/00030 reconciliado com migration repair após conferência de colunas, defaults, FKs, índices, RLS e policies já existentes. Nenhuma estrutura dessas migrations foi reaplicada.
- db push aplicou somente 00031; migration list confirma 00001–00031 sincronizadas. CHECK de ai_usage_events confirmado com task_followup_suggestion.
- API /health ok e rota nova existente (401 sem autenticação). Web build/deploy Success no EasyPanel; interface nova observada no navegador. Worker iniciou os cinco consumidores e executou o job de liberação de takeover.
- Card de Pedro abriu com resumo, parcela e modelo, histórico e ações; formulário de perda mostrou motivo/evidência e foi cancelado sem alterar oportunidade.
- Gerar outra na tarefa de Paulo Da Silva produziu texto contextual, salvou um ai_usage_event e incrementou a cota de 2 para 3 usadas (2 restantes). Reabertura manteve texto/cota. Nenhuma mensagem enviada ao cliente no teste.
- Flags preservadas: follow-up e vínculo automático ligados; consolidação, encerramento automático e LiberaCred ausentes/desligados.
- Não havia novas mensagens de cliente após o deploy durante esta conferência; última entrada 19:32:23, resposta 19:32:33 (America/Sao_Paulo). Nenhum envio de teste criado para provocar tráfego.
- Origem automática validada por testes; não se simulou webhook em produção nem alterou origem/resultado de lead real.
