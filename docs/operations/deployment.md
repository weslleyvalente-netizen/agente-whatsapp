# Deployment — Runbook Operacional

Runbook prático para deploys e migrations deste projeto. Curto e objetivo — para o passo a passo detalhado de cada ferramenta, ver a documentação oficial (EasyPanel, Supabase CLI).

## Fluxo de deploy

- **`apps/api`**: deploy manual no EasyPanel. EasyPanel → Projeto
  `agente-whatsapp` → Serviço `api` → Implantar.
- **`apps/worker`**: deploy manual no EasyPanel. EasyPanel → Projeto
  `agente-whatsapp` → Serviço `worker` → Implantar.
- **Push para `main` NÃO dispara deploy automático.** O EasyPanel builda a
  partir do Dockerfile de cada serviço, mas só quando alguém clica em
  "Implantar" — código pode estar mergeado em `main` e não estar em produção.
  Sempre confirmar explicitamente qual commit está publicado antes de
  assumir que uma mudança está no ar.

## Fluxo de migrations do Supabase

Processo oficial para aplicar migrations neste projeto:

1. Exportar o token de acesso apenas na sessão do shell (nunca gravar em
   arquivo): `export SUPABASE_ACCESS_TOKEN=...`
2. `npx supabase migration list --linked` — compara o histórico de
   migrations local com o que o CLI acha que está aplicado no remoto.
3. `npx supabase db push --dry-run` (adicionar `--include-all` se houver
   migrations pendentes fora de ordem) — mostra exatamente quais migrations
   seriam aplicadas, sem aplicar nada.
4. Ler o SQL de cada migration pendente antes de aplicar. Confirmar que não
   há `DROP`, `TRUNCATE`, `DELETE` ou qualquer operação destrutiva em tabelas
   existentes.
5. Só depois disso, rodar `npx supabase db push` (sem `--dry-run`) para
   aplicar de fato.

Use `db push` apenas quando houver migrations novas e confirmadas via
dry-run. Nunca rode `db push` "para ver o que acontece".

## Lição aprendida nesta implantação

Durante a validação do deploy do `apps/worker`, descobrimos que as tabelas
`tasks` e `task_events` não existiam no banco de produção, apesar das
migrations `00010_tasks.sql` e `00011_tasks_rls.sql` existirem no
repositório há dias.

Causa raiz: um `migration repair --status applied` feito em lote
(`00010 00011 00012 00013 00014 00015 00016`) marcou 00010 e 00011 como
aplicadas no histórico do CLI sem que elas de fato tivessem sido executadas
no banco. A partir daí, `db push --dry-run` reportava "up to date" para
essas duas migrations — mascarando completamente o problema.

Conclusões:

- **`migration repair` em lote é perigoso.** Ele só corrige o *histórico*
  que o CLI acompanha; não verifica, nem aplica, nem confirma que o schema
  real corresponde a esse histórico.
- **O histórico do CLI não substitui a verificação do schema real.** Um
  `migration list` "limpo" ou um `db push` dizendo "up to date" não é prova
  de que as tabelas existem — é só prova de que o CLI *acha* que sim.
- **Sempre conferir `information_schema.tables` quando houver qualquer
  dúvida**, por exemplo:
  ```sql
  select table_name from information_schema.tables
  where table_schema = 'public' and table_name in ('tasks', 'task_events');
  ```
  Isso é a única fonte de verdade sobre o que realmente existe no banco.

## Checklist pós-deploy

- [ ] API respondendo (testar uma rota real, não só um healthcheck vazio).
- [ ] Worker saudável (processo rodando, filas sendo consumidas).
- [ ] Logs do serviço sem erro após o deploy (checar no painel do
      EasyPanel, não só localmente).
- [ ] Banco consistente com o que o código espera (tabelas, colunas, RLS —
      validado via `information_schema`, não só via CLI).
- [ ] Funcionalidade principal do que foi alterado validada em produção,
      com dado real ou de teste explícito (e removido/cancelado depois).

## Checklist para novas migrations

1. `npx supabase migration list --linked`
2. `npx supabase db push --dry-run` (+ `--include-all` se necessário)
3. Conferir o SQL exato que será aplicado
4. Aplicar (`db push`)
5. Validar que as tabelas/colunas/policies esperadas existem de fato
   (`information_schema.tables`, `information_schema.columns`,
   `pg_policies`)
6. Validar a funcionalidade do produto que depende dessas tabelas, de ponta
   a ponta, em produção

## Boas práticas

- Evitar `migration repair` em massa (múltiplas versões de uma vez). Se for
  necessário, aplicar uma versão por vez e validar o schema real logo em
  seguida.
- Nunca assumir que uma migration foi aplicada só porque migrations
  posteriores a ela já estão aplicadas — a ordem cronológica de criação não
  garante ordem de aplicação real.
- Sempre validar com evidência do banco real (`information_schema`, uma
  query direta, ou o comportamento observado em produção) antes de concluir
  que uma implantação foi bem-sucedida. Log de sucesso na aplicação, sem
  confirmação no banco, não é suficiente.
