# Helena IA + CRM — Correções de Setembro (plano enxuto)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, sequentially, in this worktree. This is a lean plan by explicit user request — do not expand into full bite-sized TDD steps per subtask; use judgment, but still write/run tests for every behavior change.

**Goal:** Corrigir os bugs confirmados pela investigação de setembro (tarefas fechadas indevidamente, respostas duplicadas, identidade/config do agente, follow-up, vínculo com oportunidade) e aplicar as melhorias de personalidade pedidas — sem publicar, corrigir histórico ou ativar novos envios até aprovação final.

**Diagnóstico completo:** ver relatório consolidado na conversa e os 5 arquivos em `docs/superpowers/plans/investigation/`.

**Spec:** mensagens do usuário na conversa de 2026-09-23 ("Quero implementar melhorias..." e a mensagem de priorização seguinte) — não há doc de spec separado, o pedido do usuário É o spec.

## Global Constraints
- Ambiente isolado (worktree `helena-ia-crm-setembro`) — nada toca `main` nem produção além de leituras.
- Não publicar config de agente, não corrigir registros históricos em massa, não ativar novos envios automáticos — tudo isso fica para aprovação final do usuário.
- Não usar clientes reais como teste (item 10 do spec original).
- Casos reais (Eder Reis, Rogerio, Izabela, mikaelkawz, Josemario) viram fixtures de teste isolados, não dados pra "corrigir direto".
- Frase de humano/vendedor nunca conta como evidência de aceite do cliente (critério vale para auditoria de tarefas E vínculo de oportunidade).
- Ao final de cada prioridade: relatar o que mudou, evidência de teste, limitações — antes de seguir pra próxima.

---

## Prioridade 1 — Tarefas encerradas indevidamente
`autoCompleteConversationTask` (task.service.ts) completa TODAS as tarefas abertas só porque um humano assumiu a conversa, sem checar execução. Fix: parar de completar automaticamente; reassinalar ao humano (`in_progress`) e exigir conclusão explícita (rota manual `/tasks/:taskId/complete` já existe). Preservar tarefas independentes (não fundir). Produzir lista de tarefas possivelmente fechadas indevidamente (auditoria, sem reabrir em massa). Testes com os 5 casos reais como fixtures.

## Prioridade 2 — Respostas duplicadas
Sem agrupamento de mensagens em sequência (`apps/worker`, `apps/api/src/lib/queue.ts`, `apps/worker/src/lib/lock.ts`). Fix: agrupar mensagens consecutivas do cliente antes de gerar resposta, preservar ordem, checar mensagens novas e intervenção humana antes do envio final. Garantir que reprocessamento (retry) não duplica nem perde mensagem.

## Prioridade 3 — Configuração e personalidade
Corrigir nome pra "Helena" no prompt publicado SEM publicar o rascunho da voz (ElevenLabs) junto — publicar seletivamente, preservando o rascunho de voz intacto. Centralizar tabela Libera Cred (hoje duplicada em `knowledge` e `rules`) numa fonte única. Corrigir FAQ corrompida (pergunta concatenada). Tratar vazamento de `"A resposta já foi enviada"` e frases de meta-narração similares sem bloquear respostas legítimas. Reinvestigar "FAQ vazia no painel" só se reproduzir de novo (dado hoje mostra 12 ativas — preservar, não recriar). Consolidar regras de personalidade pedidas (tom, 1 pergunta por vez, no máx. 1 emoji, não inventar urgência, identificar-se como assistente virtual, etc.), regras do Libera Cred (moto não sai na 1ª parcela, checar parcela E prazo separadamente, não insistir após recusa, não oferecer financiamento quando já há condição incompatível relatada) e distinção intenção/execução (não dizer "em análise"/"confirmei" sem evidência).

## Prioridade 4 — Follow-up
Adicionar janela configurável 08h–18h America/Sao_Paulo (não existe hoje). Checar `scheduled_callback`/`scheduled_date` antes de reabordar (existe no schema, não é checado). Distinguir "aguardando cliente" (pode reabordar) de "aguardando equipe/banco" (deve virar tarefa/alerta interno, não cobrança ao cliente). Preservar o que já funciona: cadência 1h/23h ancorada na última mensagem do cliente, revalidação antes do envio, respeito a `ai_disabled`/takeover humano.

## Prioridade 5 — Vínculo com oportunidade e contexto humano
Corrigir `create-task` (tool de IA) pra passar `opportunity_id` na criação/dedup — hoje nunca passa, então duas oportunidades abertas do mesmo contato cruzam tarefas. Quando houver ambiguidade (mais de uma oportunidade aberta, não dá pra saber qual), não escolher arbitrariamente — sinalizar para triagem humana. UI: mostrar no painel de atendimento a qualificação já salva no banco (`conversation_qualifications` — produto, orçamento, entrada, parcela, próxima ação), hoje não lida em lugar nenhum do `apps/web`. Depois, se der tempo dentro desta entrega: campos de "última proposta" (fonte/data) e "objeção principal" — precisam de schema novo, avaliar no momento.

---

## Ordem de execução
Sequencial, 1→5, relatando ao final de cada uma. Nenhuma publica/migra/envia sem aprovação.
