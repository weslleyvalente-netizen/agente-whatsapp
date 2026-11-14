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

## Mensagem ACEITA pela Evolution × mensagem ENTREGUE ao WhatsApp
São coisas diferentes, e a sincronização usa a primeira:
| Momento | O que significa | Onde fica registrado |
|---|---|---|
| Enfileirada | O CRM gravou a mensagem e colocou o envio na fila. Pode falhar. | linha em `messages`, sem `evolution_message_id` |
| **Aceita pela Evolution** | A Evolution respondeu OK ao `sendText` e devolveu o id da mensagem (`key.id`). A mensagem entrou no WhatsApp; ainda **não** há garantia de que chegou ao celular do cliente. | `messages.evolution_message_id` preenchido |
| Entregue | O WhatsApp confirmou a chegada ao aparelho do cliente (avisos `MESSAGES_UPDATE` do webhook). | `messages.delivered_at` (e `read_at` quando lida) |
- **`waiting_on` muda na aceitação** (worker de envio, depois do OK da Evolution), não na entrega: a entrega pode demorar horas (cliente sem internet) e, para efeito comercial, a bola já está com o cliente. Antes da aceitação (enfileirada) nada muda.
- Risco aceito: uma mensagem aceita pode nunca ser entregue (cliente bloqueou, número inválido, aparelho desligado). O campo fica "aguardando cliente" e o cutucar, quando ativo, cobra o vendedor. Uma refinação futura é sinalizar "aceita e não entregue em X h" usando `delivered_at`.
- **Falha definitiva de envio** (esgotou as tentativas): a mensagem recebe `send_failed_at` (#98), **nada** é sincronizado e o campo não muda.

## Migração SQL do modo sombra: procedimento
- **O pipeline NÃO aplica migrações.** O CI (`.github/workflows/ci.yml`) só faz build e testes; o deploy do EasyPanel só constrói e publica as imagens. Migrações são aplicadas **manualmente** no Supabase do CRM (SQL Editor), como nas migrações anteriores do projeto (ver `docs/financing-mock.md`).
- Arquivo: `supabase/migrations/20261114120000_waiting_on_sync_shadow.sql`. É **aditiva e idempotente** (`CREATE TABLE/INDEX IF NOT EXISTS`), não altera tabelas existentes e liga RLS sem políticas (só o service role lê e escreve).
- **Opcional e sem ordem obrigatória:** o código tolera a ausência da tabela (cai para uma linha de log `waiting-on-sync[shadow]`). Aplicar antes de ligar `waiting_on_sync_mode = "shadow"` para ter o relatório em SQL.
- Passos: (1) colar o arquivo no SQL Editor e executar; (2) conferir `select count(*) from public.waiting_on_sync_shadow;` (deve ser 0); (3) só então ligar `shadow`.
- Reversão: `drop table public.waiting_on_sync_shadow;` (contém apenas decisões simuladas; nenhum dado de negócio depende dela).

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
