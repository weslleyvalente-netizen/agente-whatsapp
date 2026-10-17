# IA continua atendendo fora do horário depois de encaminhar ao humano

Aprovado pelo usuário em chat (2026-10-17). Problema medido (7 dias): 27 encaminhamentos (`requestHuman`) fora do horário; em 12 (44%) o cliente voltou a escrever e a IA ficou muda (20 mensagens, espera mediana 13 h, máx. 5 dias no fim de semana). Causa: depois do `requestHuman` a conversa fica com `is_human_takeover = true` e (a) o webhook (`apps/api/src/routes/webhooks/evolution.ts`, ~linhas 440-448) responde `skipped: "human_takeover"` sem enfileirar a IA; (b) o worker (`apps/worker/src/workers/process-message.ts`, ~88-94 e ~280-291) também descarta. O encaminhamento por `requestHuman` só termina com resposta humana real (ver `getExpiredTakeovers` e `handoff_events.first_human_reply_at`).

## Regra nova ("modo noite")
Condição, avaliada no webhook E revalidada no worker (para não enfileirar/responder fora da regra):
1. `conversation.is_human_takeover === true`;
2. existe `handoff_events` com `trigger_type = 'request_human'` para a conversa e `first_human_reply_at IS NULL` (encaminhamento da IA ainda sem resposta humana) — use/estenda as queries existentes em `packages/database/src/queries/handoff-events.ts` (por exemplo `getConversationIdsWithOpenRequestHumanHandoff`);
3. a organização está **fora do horário comercial** agora: `isBusinessOpen(new Date(), resolveBusinessCalendar(org.settings.business_calendar))` é falso (`packages/shared/src/business-calendar.ts`; fuso America/Sao_Paulo, padrão seg–sex 08–18; sábado/domingo fechados);
4. o contato NÃO tem `ai_disabled`.
Quando as 4 condições valem, a mensagem do cliente é processada pela IA normalmente (mesma fila `process-message`, mesma ordem/lock/debounce), com um **sinal explícito** no job (ex.: `afterHoursPending: true`) e **sem** alterar `is_human_takeover`, `human_takeover_at` nem `handoff_events`. Dentro do horário comercial nada muda: o silêncio da IA depois do encaminhamento continua (o vendedor está lá).

## Comportamento da IA nesse modo (agent-runtime)
- Acrescentar ao contexto do turno (instrução de sistema adicional, só nesse modo): "Você já encaminhou este cliente para a equipe, que responde quando a loja reabrir (8h às 18h, seg–sex). Continue ajudando com dúvidas (modelos, estoque, preços via ferramentas, condições cadastradas, se o número/loja é verdadeiro, endereço). NÃO chame requestHuman de novo e não prometa prazo ou resposta de consultor além de 'quando reabrirmos'. Não repita o aviso de fora do horário em toda mensagem (só se o cliente perguntar). Se o cliente apenas agradece/confirma ('ok', 'obrigado'), responda curto e cordial ou não responda; se pedir algo que só um humano resolve, diga que a equipe retoma ao reabrir."
- **Remover a ferramenta `requestHuman`** do conjunto de ferramentas nesse modo (e `createTask` duplicada se fizer sentido) para impossibilitar novo encaminhamento. Demais ferramentas (searchCatalog, searchFaq, searchKnowledge, sendVehiclePhoto etc.) ficam.
- As mensagens da IA são gravadas com `role = 'agent'` como hoje e **não** contam como resposta humana: `first_human_reply_at` continua nulo; o SLA/alertas do vendedor seguem iguais; o card continua "Pronto para assumir".
- Cuidado com o eco: mensagens enviadas pela IA voltam da Evolution como fromMe; garantir que isso NÃO cria takeover/handoff novo nem conta como atendimento humano (o dedup por `evolution_message_id` já existe; confirme com teste).
- `shouldDropReplyForTakeover` (worker ~287): no modo noite, a resposta NÃO deve ser descartada pelo takeover; deve ser descartada se um humano responder no meio (revalidar antes de enviar: se `first_human_reply_at` ficou preenchido ou a loja abriu e a conversa está em takeover, descartar).

## Segurança operacional
- Nada de loop: a IA responde 1 vez por mensagem do cliente (como hoje); limite por conversa de respostas no modo noite (ex.: máx. 20 por noite) para evitar custo/abuso; ao estourar, silêncio.
- Flag de organização `settings.ai_after_hours_pending_enabled` (default **desligado**) para liberar gradualmente; o usuário liga depois do deploy. Tipar em `packages/shared/src/types/organization.ts` e expor um interruptor em Configurações junto dos de distribuição (apps/web/src/app/(dashboard)/settings/page.tsx), só owner/admin.
- Log claro quando a IA responde em modo noite (id da conversa), sem dados pessoais.

## Testes (vitest, padrão dos existentes)
- Função pura `shouldRunAiAfterHours({isHumanTakeover, hasOpenRequestHumanHandoff, businessOpen, aiDisabled, flagEnabled})` em packages/shared (com testes de tabela, incluindo sábado, 17:59/18:00, flag desligada).
- Webhook: conversa em takeover por requestHuman fora do horário → enfileira com o sinal; no horário comercial → continua `skipped: human_takeover`; takeover manual de humano (sem handoff request_human aberto) → continua pulando; ai_disabled → pula; flag desligada → pula.
- Worker/agent-runtime: no modo noite requestHuman não está entre as ferramentas e a instrução extra é enviada; resposta enviada e não marca atendimento humano; se um humano respondeu no meio, descarta; limite por conversa.
- Teste do eco da própria IA não criando handoff/takeover.

## Verificação
tsc de api/worker/shared/database/agent-runtime/web; vitest de api, worker, shared, agent-runtime, database; `next build` com NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy. Não fazer push nem abrir PR, não tocar em produção, sem subagentes. Commits terminando com: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>.
