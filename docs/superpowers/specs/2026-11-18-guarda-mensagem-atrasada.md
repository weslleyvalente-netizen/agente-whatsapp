# Proteção contra mensagem atrasada de cliente

**Status:** proposta. Desligada por padrão (`settings.stale_message_guard_mode` ausente = `off`). Sem migração.

## Problema
Depois de uma queda da conexão (18/11/2026: ~3 h sem receber, estado sempre `open`), o Evolution pode entregar em lote mensagens antigas.
O webhook as grava com `created_at = agora` (só a recuperação interna usa o horário original) e as enfileira para a IA sem checar a idade:
a MarIAna responderia mensagens de horas atrás como se fossem novas.

## Comportamento
Idade = agora − `messageTimestamp` do payload (timestamp original do WhatsApp, em segundos). Limite: `stale_message_guard_minutes` (padrão 20, mín. 5, máx. 1440).

| modo | efeito |
|---|---|
| `off` (padrão) | nada muda; nem lê a organização |
| `shadow` | grava `metadata.stale_guard` (o que faria) e loga `[SOMBRA]`; a IA responde como hoje |
| `on` | mensagem atrasada **não vai para a IA**; a conversa passa a atendimento humano (takeover) e o responsável é avisado por push (sem responsável: gestores) |

Regras:
- A mensagem **sempre é gravada** (a proteção roda depois do `saveMessage`; duplicata continua saindo como `duplicate` antes dela).
- Sem timestamp utilizável, ou timestamp > 5 min no futuro (relógio errado): **não** é tratada como atrasada; fluxo como hoje.
- Cada mensagem é avaliada pelo próprio timestamp (lote fora de ordem: só as velhas são retidas).
- Já respondida (existe resposta `agent`/`human_agent`/`system` depois do horário original): a IA não responde e **não** há takeover nem aviso.
- Falha em ler configuração/estado nunca bloqueia o atendimento (segue como hoje). Falha ao checar "já respondida" conta como não respondida.
- Mensagens da recuperação interna (cabeçalho com `REPLAY_TOKEN`) não passam pela proteção.
- Contato sem vendedor: entra em takeover sem dono e aparece na fila "Precisam de resposta" dos gestores. **Não** grava `assigned_to`, **não** chama o rodízio e **não** cria evento de handoff.
- Tráfego normal não paga leitura extra: mensagem com menos de 5 min nem consulta o banco.

## Limitações conhecidas
- Takeover segue o prazo existente (`human_takeover_timeout_minutes`); depois dele a IA volta a atender a conversa.
- Mensagens novas que chegarem depois de uma atrasada, enquanto o takeover estiver ativo, também ficam com o humano (comportamento atual do takeover).
- A recuperação automática (`auto_recover_messages_enabled`) continua encaminhando à IA o que ela decidir recuperar; a proteção não interfere nela.

## Ativação sugerida (cada passo exige autorização)
1. Merge e deploy com a chave ausente (`off`).
2. `stale_message_guard_mode = "shadow"` por alguns dias úteis; conferir `metadata->'stale_guard'` nas mensagens.
3. `"on"`. Rollback: `"off"` (efeito imediato, sem migração).

## Segundo ponto de proteção: o processamento (worker)
O webhook só vê a entrega atrasada do WhatsApp. Em 18/11 a IA mandou 4 respostas em 13 s (16:19 BRT) a conversas cujo último cliente tinha escrito 1h a 1h35 antes:
essas mensagens eram "recentes" para o webhook. Por isso a MESMA regra (`applyStaleMessageGuard`, em `@aula-agente/shared`) roda também em `process-message`:
- **No início do job** (antes de gastar LLM, áudio ou imagem), com a idade da mensagem MAIS RECENTE do lote. Cobre fila lenta, retry do BullMQ e reinjeção do varredor (que é só outro job).
- **Antes de enviar**: relê o estado e descarta a resposta se (1) um humano respondeu depois da mensagem do cliente (`hasHumanMessageAfter`, mesmo sem takeover gravado), (2) o takeover/`ai_disabled` mudou, (3) chegou mensagem nova do cliente (já existia) ou (4) a mensagem ficou atrasada durante a geração.
- **Instante usado:** `metadata.wa_original_at` (gravado pelo webhook, a partir do `messageTimestamp`); sem ele, `created_at`. Um "original" depois da chegada (relógio) é ignorado.
- **Sem repetição:** o takeover é ligado por `UPDATE ... WHERE is_human_takeover = false` (atômico). Só quem LIGOU avisa; jobs repetidos/concorrentes da mesma conversa não repetem push nem encaminhamento.

## Comportamento nas falhas (modo `on`)
| Falha | Resultado |
|---|---|
| leitura da configuração (modo desconhecido) | segue como hoje (a proteção é opt-in); registrado no log |
| checar "já respondida" | conta como NÃO respondida: a IA não responde, vai para humano |
| gravar a marca `stale_guard` | a IA continua sem responder |
| ligar o takeover | a IA continua sem responder; `humanQueued=false`; o responsável (ou gestores) recebe push; a mensagem fica gravada e visível na caixa de entrada |
| enviar o push | a IA continua sem responder; takeover já gravado |
| ler "humano respondeu" antes de enviar | não bloqueia (o takeover relido no mesmo ponto cobre o caso comum) |
Modo `on` já conhecido nunca devolve uma mensagem atrasada à IA por causa de uma falha de apoio. Única porta de volta: não conseguir ler a configuração.

## Visibilidade do encaminhamento (verificado no código e por leitura da função SQL)
- Conversa em takeover entra em "Precisam de resposta" (`attention_queue_candidates`: dono OU takeover). Hoje (leitura, 7 dias): 46 awaiting e 16 new_lead, todas com dono.
- **Vendedor** (modo `own`) vê só o que é dele: um contato SEM dono em takeover NÃO aparece para Marina/Márcio.
- **Gestor** (modo `all`) só vê a fila se o id dele estiver em `needs_reply_queue_user_ids`; hoje a lista tem só Marina e Márcio. Logo, **um contato sem dono retido pela proteção não aparece em nenhuma fila "Precisam de resposta" hoje**. Ele chega ao gestor pelo push e fica em takeover na caixa de entrada.
- Antes de ligar `on`: incluir o id do gestor em `needs_reply_queue_user_ids` (mudança de configuração, exige autorização). Nada neste PR altera dono, rodízio ou essa lista.

## Ativação única (proposta; cada passo exige autorização)
1. Merge de #107 e deste PR; deploy de api e worker com a chave ausente (`off`). Conferir `/health` e que o worker reiniciou.
2. Incluir o gestor em `needs_reply_queue_user_ids` e confirmar que a fila aparece para ele (e que Marina/Márcio seguem vendo só o que é deles).
3. `stale_message_guard_mode = "shadow"` por 2 a 3 dias úteis. Conferir `metadata->'stale_guard'` (`source` webhook/worker) e quantas mensagens seriam retidas, em especial as de fila lenta.
4. `"on"` com `stale_message_guard_minutes` = 20 (ajustar pelo que a sombra mostrar). Acompanhar 24 h: pushes recebidos, conversas em takeover sem resposta humana.
5. Rollback imediato: `"off"` (sem migração). Conversas já em takeover seguem os prazos normais de takeover.
