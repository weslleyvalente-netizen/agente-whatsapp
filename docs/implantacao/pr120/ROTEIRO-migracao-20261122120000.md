# Roteiro final: migração 20261122120000 (PR #120)

Aplicação prevista para domingo, 22/11/2026, fora do pico, **somente após autorização expressa do dono**. O merge e as flags ficam para etapas posteriores.

## 1. Pré-verificação (somente leitura, 22/11 às 11:34 UTC)

| Item | Resultado |
|---|---|
| Projeto | `fwwulkmriqkrzozcsqnx` (crm-login-dashboard), Postgres 17.6 |
| Arquivo | `supabase/migrations/20261122120000_commitments_followup.sql`: SHA-256 `63fe381f…e18ca8`, md5 `1bca2eaa…85ffa4`, 9.452 bytes |
| Objetos novos | Nenhum existe ainda (sem colisão) |
| Dependências | 6 tabelas, `distribute_lead(...) → uuid`, `get_user_org_ids()` e `gen_random_uuid`: todos presentes; nenhuma das 19 colunas usadas está ausente |
| `handoff_events` | 2.329 linhas, todas aceitas pela nova regra. `ia_sem_resposta`, `alta` e `sistema` já são aceitos. Nenhum gatilho na tabela |
| FKs para `wa_contacts` | Todas de 1 coluna; nenhum índice único por `contact_id` |
| Carga | Nenhuma transação longa |
| Flags do #120 | Ausentes (desligadas) |

## 2. Backup

- 8 backups físicos diários com status **COMPLETED**, de 15/11 a 22/11.
- O mais recente é de **22/11 às 04:57 UTC** (01:57 em Brasília).
- Há "Restore" no projeto e "Restore to new project".
- **PITR não está ativo.** Uma restauração volta o banco inteiro à hora do backup e perde tudo depois dela. É último recurso.
- A prova completa de que o backup restaura seria um "Restore to new project": cria outro projeto, tem custo e não toca produção. **Não foi feito**; precisa de autorização separada.
- A migração não altera nem apaga dados existentes. O único objeto existente que ela muda é a constraint `handoff_events_trigger_type_check`, cuja definição antiga está no script 3.

## 3. Registro no histórico de migrações (revisado)

- **Situação atual:** `supabase_migrations.schema_migrations` tem 50 registros e o último é `20261113222105`.
  - 25 migrações do repositório (`20261017120000` → `20261120140000`) foram aplicadas pelo SQL Editor sem registro.
  - 2 registros não estão no repositório: `20261021193606 manual_financing` e `20261113222105 lead_ad_touches`.
  - **Não usar `supabase db push`**: ele tentaria reaplicar as 25.
- **Formato adotado:** o mesmo dos registros feitos pelo painel, que gravaram `statements` com o conteúdo integral e `created_by` preenchido.
  - `version='20261122120000'`, `name='commitments_followup'`.
  - `statements = ARRAY[<arquivo inteiro>]`, delimitado por `$mig_20261122120000$`, sem risco de colisão com o `$$` das funções.
  - `created_by='sql_editor_pr120'`.
- **Mesma transação** que a migração: ou ficam os dois, ou nenhum.
- **INSERT sem `ON CONFLICT`**: se a versão já existir, a transação inteira aborta. Não há registro silencioso nem dupla aplicação.
- A validação confere o md5 do conteúdo gravado contra o do arquivo.
- O reparo das 25 migrações sem registro é uma tarefa separada (`supabase migration repair --status applied`, conferindo cada uma antes). Está fora desta etapa.

## 4. Impacto com todas as flags desligadas

**Nesta etapa, só a migração (o código em produção continua o do `main`, `be909ce`):** nenhuma mudança de funcionamento.

- O `main` não referencia nenhum objeto novo. `git grep` por `seller_commitments`, `proposal_followups`, `adopt_lid_contact`, `distribute_escaped_lead` e `sistema_sem_resposta` em apps e packages: 0 ocorrências.
- As tabelas novas ficam vazias e ninguém as lê nem grava.
- As funções novas só podem ser executadas pelo `service_role`, e nenhum código as chama.
- A constraint só **amplia** os valores aceitos: tudo que é gravado hoje continua aceito, e nenhuma linha nova com o valor novo surge sem o código do #120 e a flag.
- Bloqueio: escritas em organizations, opportunities, conversations e handoff_events esperam menos de 1 s. Se o bloqueio não sair em 5 s, a transação aborta sem efeito.

**Para a etapa seguinte (merge com flags desligadas), há 2 mudanças NÃO condicionadas a flag no código do PR.** Precisam de decisão antes do merge:

1. **Selo âmbar "Follow-up · cliente sem responder"** no funil, em cards com tarefa de cutucar (`customer_nudge`) vencida. Essa tarefa já existe hoje, então o selo apareceria logo após o deploy.
2. **A tarefa de cutucar é encerrada quando o cliente responde** (worker customer-nudge), com a nota "O cliente respondeu — lembrete de cutucar encerrado."

Tudo o mais fica inerte sem flag:

- worker de promessas;
- urgentes;
- @lid;
- rodízio de quem escapa;
- feriados (sem `holiday_set` o calendário é idêntico);
- card de métricas.

Mudanças que existem mas não alteram resultado:

- O `remoteJidAlt` da UAZAPI só é usado quando o chat é `@lid`.
- Há dois endpoints novos de gestor, só de leitura.

## 5. Execução (após autorização)

1. Conferir a carga no SQL Editor (esperado: 0):

   ```sql
   select count(*) from pg_stat_activity where xact_start < now() - interval '1 minute';
   ```

2. Nova query → colar **`1-aplicar-20261122120000.sql`** inteiro.
   - São 288 linhas, com SHA-256 `5a536541…0cbcfc2`.
   - Conteúdo: `BEGIN`, a migração sem alteração, o registro no histórico e `COMMIT`.
3. O painel pode avisar sobre operação destrutiva por causa de `DROP CONSTRAINT IF EXISTS` / `DROP POLICY IF EXISTS`. Elas recriam a constraint e as políticas na mesma transação; confirmar.
4. Run. Esperado: "Success. No rows returned".

## 6. Validação

- Rodar **`2-validar-20261122120000.sql`** (somente leitura). São **16 linhas**, todas com `ok = true`.
- Elas cobrem:
  - o histórico e a integridade do conteúdo (md5);
  - as tabelas, vazias;
  - RLS e políticas só de SELECT;
  - índices e únicos;
  - SECURITY DEFINER e search_path;
  - EXECUTE só para `service_role`;
  - a constraint nova validada;
  - zero `sistema_sem_resposta`;
  - uma chamada inofensiva que deve devolver `invalid`;
  - as flags desligadas.
- Depois, acompanhar os logs da API e do worker e o webhook por 10 minutos.

## 7. Recuperação

- **Falha durante a aplicação:** tudo é desfeito, inclusive o histórico. A validação confirma que nada existe. Erro de bloqueio: tentar mais tarde. Outro erro: parar e analisar.
- **Comportamento inesperado:** nesta etapa nenhum código usa os objetos novos. Se ainda assim for preciso, rodar **`3-reverter-20261122120000.sql`** com autorização. Ele:
  - remove as funções;
  - remove as tabelas vazias e **renomeia** as que tiverem dados (`*_revertida_20261122`);
  - restaura a constraint antiga só se não houver `sistema_sem_resposta`;
  - apaga o registro do histórico.
  - **Não apaga nenhum dado.**
- **Último recurso:** restaurar o backup das 04:57 UTC, perdendo as alterações posteriores.

## 8. Ensaio local (Postgres real via pglite, 22/11)

| Cenário | Resultado |
|---|---|
| Aplicar | 16/16 ok; histórico com o conteúdo idêntico ao arquivo |
| Aplicar de novo | Abortada pela chave do histórico; estado intacto, 16/16 ok |
| Reverter sem dados | Objetos removidos, constraint antiga de volta, histórico limpo, handoffs preservados |
| Reverter com dados | Tabela guardada (`seller_commitments_revertida_20261122`), constraint ampliada mantida |
| Falha no meio | Nada criado, histórico intacto |
