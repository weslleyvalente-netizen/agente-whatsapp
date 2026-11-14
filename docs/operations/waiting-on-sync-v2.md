# Sincronização de `waiting_on` (v2): modos, regras e como validar

## Modos (`organizations.settings.waiting_on_sync_mode`)
| Valor | Efeito |
|---|---|
| ausente / `"off"` | Nada acontece (padrão). Compatível: `waiting_on_sync_enabled === true` sem o modo novo equivale a `"on"`. |
| `"shadow"` | Calcula as decisões, **não altera nenhum negócio** e grava o que FARIA em `waiting_on_sync_shadow` (ou em log, se a tabela ainda não existir). |
| `"on"` | Aplica a mudança com guarda otimista e grava `opportunity_events` (`waiting_on_changed`, `changed_by_type='system'`) com valores anterior e novo, origem e motivo. |

A migração `20261114120000_waiting_on_sync_shadow.sql` é **opcional** e aditiva (só para o modo sombra gravar em tabela). Não é aplicada pelo deploy.

## Máquina de estados (só sobre os textos automáticos; texto próprio = edição humana, nunca tocado)
| Estado | waiting_on | Próxima ação |
|---|---|---|
| HANDOFF | team | Atender cliente encaminhado pela IA |
| AWAIT | customer | Aguardar resposta do cliente |
| REPLIED | team | Responder ao cliente |
| DECLINED | team | Cliente disse não: confirmar interesse |
| PROMISED | team | Retornar ao cliente |

1. **HANDOFF → AWAIT:** humano concluiu o atendimento do repasse, respondeu, e a última mensagem **não** é do cliente.
2. **AWAIT → REPLIED / DECLINED:** o cliente respondeu (texto, áudio, mídia). Agradecimento puro, risada, figurinha e o contexto do anúncio não contam. "Não" conta, mas vai para DECLINED e **não volta sozinho**: a decisão é humana.
3. **HANDOFF / REPLIED / PROMISED → AWAIT:** o vendedor fez **proposta** (valores/condições, documento ou imagem) ou **pergunta** ao cliente.
4. **HANDOFF / REPLIED / AWAIT → PROMISED:** o vendedor prometeu verificar/enviar algo ("vou verificar", "te aviso", "já te retorno").
- Mensagem "não trivial" sozinha **não** basta. Áudio do vendedor, cortesia e informação não mudam nada.

## Nunca age
- Negócio fechado, congelado, ou com data combinada futura; `waiting_on` diferente de equipe/cliente automático (banco, data combinada).
- Etapas da equipe: simulação, banco, condições aprovadas, financiamento recusado.
- Tarefa aberta da **equipe** no negócio (simulação, documentos, retorno agendado, financiamento, aguardando dados/CPF...). Só alertas de silêncio (cutucar, cliente parou, negociação parada) não impedem.
- Mais de um negócio aberto do contato; texto da próxima ação diferente dos automáticos; alteração concorrente (a atualização só vale se o estado ainda é o lido).

## Pontos de entrada
Conclusão de tarefa (`/tasks/:id/complete`), resposta do cliente (webhook), mensagem do vendedor pelo celular (webhook `fromMe`) e pelo painel (`sendPanelMessage`, depois de enfileirar o envio). Todos best-effort: nunca lançam nem bloqueiam a operação principal.

## Relatório do modo sombra (somente leitura)
```sql
-- Decisões por regra e quantas ainda coincidem com o estado atual do negócio
select s.rule, count(*) as decisoes,
       count(*) filter (where o.waiting_on = s.would_set->>'waiting_on' and o.next_action = s.would_set->>'next_action') as ainda_coincide,
       count(*) filter (where o.next_action is distinct from s.observed->>'next_action' and o.next_action not in (s.would_set->>'next_action')) as humano_mudou_depois
from waiting_on_sync_shadow s join opportunities o on o.id = s.opportunity_id
where s.created_at > now() - interval '5 days'
group by s.rule order by decisoes desc;

-- Amostra de 30 para Marina e Márcio conferirem
select s.created_at, s.rule, s.trigger, c.name, s.observed->>'waiting_on' as hoje, s.would_set->>'waiting_on' as faria, s.evidence
from waiting_on_sync_shadow s join opportunities o on o.id = s.opportunity_id join wa_contacts c on c.id = o.contact_id
where s.created_at > now() - interval '5 days' order by random() limit 30;
```

## Critérios de aceite para sair da sombra
Concordância de pelo menos 90% na amostra de 30; zero decisões em etapa da equipe; zero edição humana contrariada; nenhum negócio com mais de uma mudança por minuto (ping-pong).
