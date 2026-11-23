# Roteiro: migração 20261122150000 (PR #122)

Somente com **autorização expressa do dono**. Aplicar pelo SQL Editor do projeto `fwwulkmriqkrzozcsqnx`. **Nunca `supabase db push`.**

## O que a migração faz

- Adiciona `tasks.commitment_kind`: texto, nulo, sem default, CHECK `return_customer | proposal_followup`.
  - É a marca não editável da tarefa da rotina de compromissos.
  - Só altera o catálogo; nenhuma linha é reescrita.
- Cria o índice único parcial `tasks_commitment_open_per_conversation`.
  - Garante no máximo uma tarefa aberta por conversa e por marca, inclusive com duas execuções simultâneas.
  - Hoje ele não contém nenhuma linha.
- Nenhuma tarefa existente é marcada. Com `commitments_enabled` desligado, nada muda no CRM.

## Histórico de migrações (não registradas)

- Mesmo procedimento do #120. Há migrações aplicadas pelo SQL Editor sem registro em `supabase_migrations.schema_migrations`, e por isso o `db push` tentaria reaplicá-las.
- O script 1 registra a versão `20261122150000` (`tasks_commitment_kind`, `created_by = 'sql_editor_pr122'`).
  - `statements` recebe o conteúdo integral do arquivo, delimitado por `$mig_20261122150000$`.
  - O registro é feito na **mesma transação** da migração.
  - O INSERT não tem `ON CONFLICT`: se a versão já existir, tudo aborta.
- Arquivo da migração:

  | | |
  |---|---|
  | SHA-256 | `fef65335623ebb0341e07072ff92bc355808945a1ccf658dbf169387ba6399cb` |
  | md5 | `28e8e032b85a6e7ce9494bf7d11213a2` |
  | Tamanho | 1.313 bytes |

- O script 2 confere o md5 gravado no histórico.
- O reparo das migrações antigas sem registro continua fora desta etapa.

## Ordem

1. **`0-preverificar-20261122150000.sql`**
   - Somente leitura.
   - Todas as linhas devem vir com `ok = true`.
   - Se `sem_transacao_longa` vier false, esperar.
2. **`1-aplicar-20261122150000.sql`**
   - Colar o arquivo inteiro e rodar.
   - É uma transação só, com `lock_timeout` de 5 s.
   - O bloqueio na tabela `tasks` dura milissegundos: a tabela tem cerca de 3 mil linhas e o índice parcial fica vazio.
   - Se o lock não sair em 5 s, a transação aborta sem efeito e basta repetir depois.
3. **`2-validar-20261122150000.sql`**
   - Somente leitura.
   - Todas as linhas devem vir com `ok = true`.
   - Se alguma vier false: parar e diagnosticar. **Não reverter automaticamente.**
4. Só depois disso, e com autorização, vêm:
   - o merge do #122, que reimplanta API, web e worker;
   - a ativação de `commitments_enabled`, conforme o #121.

A ordem "migração antes do merge" é a recomendada. O código do #122 não quebra sem a coluna enquanto a flag estiver desligada: só a rotina de compromissos, ligada pela flag, usa a coluna. **Mas a flag nunca deve ser ligada sem a migração.**

## Reversão (`3-reverter-20261122150000.sql`)

- Só com autorização.
- Aborta sozinha se `commitments_enabled` estiver ligado.
- Se já houver tarefas marcadas, guarda as marcas em `public.tasks_commitment_kind_revertida_20261122` (com RLS ligada) antes de remover.
- Remove o índice, a coluna (junto com a CHECK) e o registro do histórico.
- Não apaga tarefas.
