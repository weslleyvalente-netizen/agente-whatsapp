# Runbook: isolamento por vendedor (RLS)

Spec: docs/superpowers/specs/2026-10-08-seller-isolation-rls-design.md

## O que é
Faz o banco impedir que um vendedor leia ou altere o que pertence a outro vendedor (conversas, mensagens, negócios, tarefas e dependentes), inclusive no inbox ao vivo. Só vale com `organizations.settings.seller_isolation_enabled = true`. Gestores (owner/admin) veem tudo. Organização sem vendedores em `sales_reps` não é restringida.

## 1. Aplicar as migrations (desligadas)
1. Na raiz do repositório: `bash scripts/build-seller-isolation-sql.sh` (gera `/tmp/seller-isolation-migrations.sql`).
2. No Supabase: SQL Editor → New query → colar o arquivo inteiro → Run. Deve responder "Success". Tudo ou nada (uma transação).
3. Conferir: a função `seller_can_see` existe e nada mudou para os usuários (o interruptor está desligado).

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

## Comportamentos a saber
- Um **vendedor não consegue passar uma conversa/negócio dele para outro vendedor** (a linha sairia da visão dele). Só o gestor transfere entre vendedores. O vendedor pode soltar (deixar sem dono) e pegar o que está sem dono.
- Durante o modo sombra da distribuição, leads novos têm dono "legado" (conta compartilhada) e ficam visíveis aos dois vendedores.
- API e worker usam chave de serviço e ignoram RLS (não são afetados).
