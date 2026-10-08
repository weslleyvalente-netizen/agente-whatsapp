# Runbook: isolamento por vendedor (RLS)

Spec: docs/superpowers/specs/2026-10-08-seller-isolation-rls-design.md

## O que é
Faz o banco impedir que um vendedor leia ou altere o que pertence a outro vendedor (conversas, mensagens, negócios, tarefas e dependentes), inclusive no inbox ao vivo. Só vale com `organizations.settings.seller_isolation_enabled = true`. Gestores (owner/admin) veem tudo. Organização sem vendedores em `sales_reps` não é restringida.

## 0. Pré-requisito: deploy da API
O funil e as tarefas leem pela API (chave de serviço, que ignora RLS). O filtro por vendedor da API passa a valer com `seller_isolation_enabled` **ou** `lead_distribution_enabled`, e `PATCH /conversations/:id` e `POST /messages/send` também respeitam o vendedor. **Faça o deploy da API antes de ligar o interruptor**; só o SQL isola inbox e dados lidos direto pela tela.

## 1. Aplicar as migrations (desligadas)
1. Na raiz do repositório: `bash scripts/build-seller-isolation-sql.sh` (gera `/tmp/seller-isolation-migrations.sql`).
2. No Supabase: SQL Editor → New query → colar o arquivo inteiro → Run. Deve responder "Success". Tudo ou nada (uma transação).
3. Conferir: as funções existem e nada mudou para os usuários (o interruptor está desligado).
4. **Pré-checagem de políticas (obrigatória).** Uma política extra permissiva (criada à mão ou por migration antiga) soma-se às nossas (OR) e anula o isolamento. Rode:
```sql
select tablename, policyname, cmd, roles from pg_policies
 where schemaname = 'public'
   and tablename in ('conversations','messages','conversation_notes','conversation_qualifications','conversation_qualification_events',
                     'handoff_events','conversation_reads','opportunities','opportunity_events','tasks','task_events','wa_contacts','lead_assignments')
 order by tablename, cmd, policyname;
```
Só podem existir as políticas esperadas: `<tabela>_select/_insert/_update/_delete` para `conversations`, `messages`, `conversation_notes`, `conversation_qualifications`, `opportunities`, `tasks`, `task_events`, `wa_contacts`; `_select/_insert/_update` em `handoff_events`; `_select/_insert` em `conversation_qualification_events` e `opportunity_events`; `conversation_reads_select/_insert/_update`; `lead_assignments_select`. Qualquer outra linha (nome diferente, ou `using (true)`) deve ser removida ou analisada antes de ligar.

## 2. Regressão com o interruptor DESLIGADO
Entrar com o Márcio, com a Marina e com o gestor: inbox, funil e tarefas devem estar **iguais a antes** (todos veem tudo).

## 3. Ligar
Configurações → Distribuição → "Isolamento por vendedor", ou por SQL:
`update organizations set settings = settings || '{"seller_isolation_enabled": true}'::jsonb where id = '<id da organização>';`

## 4. Verificação ao vivo (obrigatória)
- **Márcio:** inbox, funil e tarefas **não** mostram a carteira da Marina; só veem o que for dele ou sem dono. O inbox em tempo real não recebe mensagens de conversas da Marina.
- **Marina:** continua vendo a carteira dela.
- **Gestor (owner):** vê tudo.
- Se algo estiver errado, desligar o interruptor (passo 5) e reportar.

## 5. Reverter
Desligar o interruptor (tela ou `update organizations set settings = settings || '{"seller_isolation_enabled": false}'::jsonb where id = '<id>';`). Nada é apagado nem alterado.

## Lacunas aceitas (continuam por organização)
`conversation_metrics`, `task_followup_sends` e `ai_usage_events` não foram isoladas: um vendedor ainda pode ler esses agregados/registros da organização inteira pelo banco. Aceito nesta fase (não expõem o conteúdo das conversas); tratar em fase própria se necessário.

## Comportamentos a saber
- Um **vendedor não consegue passar uma conversa/negócio dele para outro vendedor** (a linha sairia da visão dele). Só o gestor transfere entre vendedores. O vendedor pode soltar (deixar sem dono) e pegar o que está sem dono.
- Durante o modo sombra da distribuição, leads novos têm dono "legado" (conta compartilhada) e ficam visíveis aos dois vendedores.
- API e worker usam chave de serviço e ignoram RLS (não são afetados).
