# Investigação: pipeline de processamento de mensagens (item 9)

Escopo: `apps/worker/src/workers/process-message.ts`, `apps/worker/src/lib/lock.ts`,
`apps/worker/src/lib/no-op-reply.ts`, `apps/api/src/lib/queue.ts`,
`apps/api/src/routes/webhooks/evolution.ts`, `apps/worker/src/workers/takeover-timeout.ts`.

## 1. Respostas duplicadas para mensagens em sequência — CONFIRMADO, sem correção

`apps/api/src/lib/queue.ts:3-9` — `enqueueProcessMessage` faz `queue.add("process-message", data)`
sem `delay`, sem dedup key, sem agrupamento. Cada mensagem inbound do webhook
(`apps/api/src/routes/webhooks/evolution.ts:250`) gera um job BullMQ imediato e
independente.

O lock por conversa (`lock.ts`) só serializa a EXECUÇÃO — não junta as mensagens.
Se o cliente manda "oi" e "quanto custa a Fazer?" em sequência rápida:
- Job 1 roda, gera resposta completa baseada só em "oi" (ou já vendo as duas, se
  a segunda já estiver salva no banco a tempo — mas o texto do LLM é gerado em
  cima de `getRecentMessages(db, conversationId, 20)` tirado no INÍCIO do job,
  `process-message.ts:92`, sem re-checagem depois).
- Job 2 roda em seguida (após o lock liberar) e gera OUTRA resposta completa,
  agora vendo as duas mensagens no histórico — potencialmente repetindo
  informação já respondida no job 1.

Não existe nenhum mecanismo de debounce/agrupamento de mensagens consecutivas
em nenhum lugar do código. Esse é o gap real por trás do "respostas duplicadas".

## 2. Resposta gerada antes de considerar a mensagem seguinte — CONFIRMADO

`process-message.ts:92-223`: `recentMessages` é buscado uma vez no início do job
e usado para montar `history` e chamar `runAgent`. Não há nenhuma releitura do
banco entre o fim de `runAgent` (que pode levar vários segundos com tool calls)
e o envio da resposta (`process-message.ts:259-288`). Se uma nova mensagem do
cliente chegar durante a geração, a resposta já em voo é enviada mesmo assim,
ignorando a mensagem nova — que só será tratada pelo job dela (ver item 1).

## 3. Despedidas/agradecimentos em loop — NÃO CONFIRMADO no código do worker

Não há nenhum guard ou detecção de "fim de conversa" / contador de turnos de
despedida no pipeline (`process-message.ts`, `send-message.ts`,
`stale-conversation-followup.ts`). Se esse loop existe, a causa está no PROMPT
(o modelo decidindo responder a cada "obrigado" com outro "de nada, qualquer
coisa é só chamar"), não em código de processamento — é item para a skill/fork
que revisa personalidade (item 2 do spec), não daqui. Nenhum bug de código
identificado para isso.

## 4. Vazamento de texto interno — PARCIALMENTE CORRIGIDO, gap real encontrado

- `"(sem resposta necessária)"` **já tem guard**: `apps/worker/src/lib/no-op-reply.ts`
  — regex `NO_OP_REPLY_PATTERN` cobre variações de "sem (necessidade de) (nova)
  resposta (necessária)" e é aplicado em `process-message.ts:233`
  (`!isNoOpReply(result.text)`) antes de salvar/enviar. Comentário no código
  confirma que já foi visto em produção e corrigido.
- `"A resposta já foi enviada"` **NÃO tem guard** — `grep` na base inteira (fora
  `node_modules` e `.claude/worktrees/`) não encontra essa string em nenhum
  lugar do código; ou seja, não é um texto fixo do sistema, é o MODELO
  inventando essa frase em tempo de inferência. `isNoOpReply` não cobre esse
  padrão (regex é específica a "sem resposta"). **Gap real**: precisa generalizar
  o guard para cobrir outras frases de meta-comentário/narração interna
  ("já enviei", "está enviado", "análise em andamento" sem ação real — ver
  item 4 do spec do usuário, que é sobre a mesma classe de problema no prompt).
  Recomendo tratar isso junto com o fork/task da skill de personalidade: o guard
  de código é uma rede de segurança, mas a causa raiz é o prompt permitir esse
  tipo de frase.

## 5. IA retomando contexto antigo após intervenção humana — PARCIAL, ok na mensagem, risco em estado estruturado

- Nível de mensagem: OK. `process-message.ts:73-77` só roda o job se
  `conversation.is_human_takeover` for false; `getRecentMessages(db, conversationId, 20)`
  puxa histórico cronológico incluindo mensagens `role: 'human_agent'` enviadas
  durante o takeover — a IA "vê" o que o humano disse.
  `apps/worker/src/workers/takeover-timeout.ts` libera o takeover automaticamente
  após `HUMAN_TAKEOVER_TIMEOUT_MS` (via job scheduler a cada 5 min), setando
  `is_human_takeover: false` — mecanismo já existe e está correto no nível de
  mensagem.
- Risco NÃO verificado aqui (fora do escopo deste fork, é `agent-runtime`, não
  `apps/worker`): se existir algum estado estruturado separado das mensagens
  brutas (ex.: "última proposta apresentada", "modalidade atual" cacheados em
  algum lugar do agent-runtime/tools), esse estado pode não ser invalidado
  quando o humano muda a modalidade/proposta manualmente. Recomendo que o fork
  de contexto/handoff (item 5 do spec) confirme isso olhando
  `packages/agent-runtime`.
- Limite de 20 mensagens (`getRecentMessages(db, conversationId, 20)`) pode
  cortar contexto relevante em conversas longas com handoff no meio — não é bug,
  mas é um limite fixo que vale documentar.

## 6. Infraestrutura de lock/fila já existente (reaproveitar, não recriar)

- Lock Redis por conversa com TTL de 120s e SET NX (`lock.ts:14`), até 20
  tentativas de 500ms (10s de espera máxima) antes de desistir e lançar erro
  (`process-message.ts:58-60`) — isso FAZ o job falhar e cair no retry do BullMQ
  se o lock não for adquirido a tempo. **Risco correlato encontrado**: se o job 1
  demorar mais que ~10s segurando o lock (ex. transcrição de áudio + LLM), o
  job 2 pode esgotar as 20 tentativas, falhar, e depender do retry do BullMQ
  (attempts configurados em `packages/queue/src/queues.ts` — não lido neste
  fork) para eventualmente processar a segunda mensagem. Se os retries
  esgotarem antes do lock liberar, a segunda mensagem do cliente pode ficar
  SEM resposta nenhuma — um modo de falha adjacente ao da duplicação, vale
  investigar `packages/queue/src/queues.ts` para confirmar a política de
  retry/backoff.
- `takeover-timeout.ts` já implementa liberação automática agendada — não
  precisa recriar, só garantir que qualquer nova lógica de "expiração" do spec
  (item 7, follow-up) não duplique este mecanismo.

## Não investigado (fora de escopo deste fork)

- `packages/agent-runtime` (como o prompt/contexto é montado, se há cache de
  "última proposta"/modalidade) — relevante para itens 4 e 5 do spec do
  usuário, mas fica para os forks de config/personalidade e contexto/handoff.
- `packages/queue/src/queues.ts` — política exata de retry/backoff dos dois
  filas (`process-message`, `send-message`).
