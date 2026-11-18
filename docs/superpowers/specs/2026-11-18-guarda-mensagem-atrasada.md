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
