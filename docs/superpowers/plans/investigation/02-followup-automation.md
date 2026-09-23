# Investigação: Follow-up automático (item 7 do spec)

Escopo: `apps/worker/src/workers/stale-conversation-followup.ts`, `apps/worker/src/lib/followup-nudge.ts`,
`packages/shared/src/task-helpers.ts`, `packages/shared/src/constants.ts`, `packages/database/src/queries/conversations.ts`.

## Arquitetura atual

- Job BullMQ roda a cada 15 min (`CHECK_INTERVAL_MS`), um tick por organização.
- Três sub-rotinas independentes por tick:
  1. `runStalledNegotiationCheck` — flags negociações precificadas (têm `sale_amount`) sem
     nenhuma mensagem de nenhum lado há 3+ dias (`STALLED_NEGOTIATION_DAYS`). Cria task
     `stalled_negotiation`, dedupa por conversa.
  2. `runBaselineTaskCheck` — para agentes que NÃO ativaram `followup_automatico`: só cria task
     `customer_unresponsive` (sem mandar mensagem), dedupa por conversa e por contato.
  3. Loop principal (agentes com `followup_automatico.ativo = true`) — manda as mensagens de
     followup automáticas em si. É o foco do item 7.

## O que JÁ ESTÁ corrigido (não é mais bug, apesar de soar como um no spec do usuário)

- **Âncora do relógio é a última mensagem do CLIENTE (`getLastContactMessage`), não
  `last_message_at`.** Comentário no código ("Correction #2") documenta explicitamente que isso
  evita que as próprias mensagens automáticas do followup reiniciem a contagem — exatamente o
  risco que o item 7 pede pra revisar. **Já resolvido.**
- **`decideFollowupStage` (`packages/shared/src/task-helpers.ts:114`) trava em `stage2AlreadySent`
  → `"none"`** — não existe stage 3+, não há loop infinito.
- **Re-validação imediata antes do envio**: depois de adquirir o lock da conversa
  (`acquireConversationLock`), o worker busca a conversa de novo (`getConversationById`) e
  reconfere `is_human_takeover` e `wa_contacts.ai_disabled` e se a última mensagem ainda é do
  agente — cobre exatamente o "revalidar imediatamente antes do envio" do item 7. **Já feito.**
- **`ai_disabled` é respeitado** (comentário explícito: "process-message.ts e evolution.ts já
  gate on it, this worker never did" — foi corrigido nesta mesma função).
- **`is_human_takeover` é respeitado** (skip se true).
- **Humano que respondeu por último não dispara followup da IA** — o filtro exige
  `lastMessage.role === "agent"` (não `human_agent`), então uma conversa onde um humano mandou a
  última mensagem nunca entra nesse fluxo automático.
- **1h / 23h**: vêm de `DEFAULT_FOLLOWUP_AUTOMATICO` (`packages/shared/src/constants.ts:92-95`),
  contados a partir da última mensagem do cliente (ver acima). `primeiro_followup_horas` = 1,
  `segundo_followup_horas` = 23. Configuráveis por agente (schema `z.number().min(0.5).max(168)`),
  não são hardcoded globalmente — já é por-agente, só não há UI de janela de horário (ver abaixo).
- **Mensagem não é template fixo com "fico à disposição"** — `buildFollowupNudgeInstruction`
  delega pro próprio modelo decidir o texto (ou responder string vazia se não fizer sentido
  insistir), com instrução explícita "sem soar repetitivo ou robótico". Isso reduz bastante o
  risco de urgência artificial citado no item 7 — mas o resultado real depende do prompt de
  personalidade (fora do escopo deste fork; ver `01-agent-config-state.md`).

## O que está CONFIRMADO faltando

1. **Sem janela de horário (08h–18h America/Sao_Paulo) nem configuração de horário comercial.**
   Busquei em `agent`/`organization` settings — não existe nenhum campo de horário de
   funcionamento em lugar nenhum do schema ou do worker. O job roda toda hora do dia/madrugada
   sem nenhum gate de horário. **Precisa ser criado do zero** — não é ajuste, é feature nova
   (campo em `organizations.settings` ou `agent.tools_config`, mais o gate no worker).
2. **`scheduled_callback` (retorno combinado) existe como tipo de task e tem campo `scheduled_date`
   ("Data combinada" — `packages/shared/src/constants.ts:29,47,192`) mas o worker de followup
   NUNCA consulta esse tipo de task antes de decidir mandar mensagem.** Uma conversa com
   "cliente pediu retorno em determinada data" pode receber o nudge automático de qualquer jeito
   se ficar 1h/23h sem resposta antes da data combinada chegar. **Gap real, confirmado no código.**
3. **Sem sinalização de "aguardando equipe" vs "aguardando cliente".** `getStaleWaitingConversations`
   filtra só por `status = 'waiting'` — não há diferenciação entre "esperando o cliente responder"
   e "esperando a loja agir" dentro desse status. Pelo desenho atual (só dispara quando a ÚLTIMA
   mensagem foi do agente/IA), na prática isso já deveria significar "esperando cliente" — mas não
   há um teste que prove isso pra todo caso (ex.: um humano marca a conversa como 'waiting'
   manualmente por outro motivo). Recomendo tratar como ambíguo, não como bug confirmado.
4. **Sem checagem de "aguardando banco/administradora".** Não existe task type nem status
   equivalente a "proposta enviada, aguardando resposta do banco" no schema atual
   (`opportunities` tem `stage`/`status` mas está com 0 linhas — ver `01-agent-config-state.md` e
   `03-tasks-funil-historical-cases.md`). Não há como o worker respeitar um estado que não é
   registrado em lugar nenhum hoje.
5. **Sem detecção de "recusa explícita" nem "pedido pra não receber contato".** Nenhum campo,
   tag ou task type de opt-out/do-not-contact existe no banco (`wa_contacts.metadata` está vazio
   em todos os contatos, confirmado por outro fork). Uma recusa clara do cliente ("não quero mais
   consórcio") não interrompe a cadência automaticamente — só interrompe se o cliente responder de
   novo (o que já invalida a janela de silêncio, então tecnicamente esses casos não recebem
   mensagem *nova*, mas também não há registro formal de "recusado, não tentar de novo" que
   sobreviva a um futuro período de silêncio se o cliente voltar a interagir e ficar quieto outra
   vez).
6. **Nenhuma UI/config visível pra `followup_automatico` além do schema** — não investiguei
   `apps/web` (fora do escopo deste fork), então não confirmo se existe um toggle no painel hoje.

## Ambíguo / decisão de humano necessária

- Se "aguardando equipe" deve virar um `status` de conversa novo, ou só uma regra adicional
  dentro do worker (checar se existe task tipo `pending_proposal`/similar em aberto pro contato
  antes de disparar) — schema atual não tem essa distinção, é decisão de design, não bug.
- Janela 08h–18h: usuário propôs como "inicial, sujeita à configuração comercial da loja" — decidir
  se é por organização (`organizations.settings`) ou por agente (`agent.tools_config`, que é onde
  `followup_automatico` já vive hoje — mais consistente manter no mesmo lugar).
