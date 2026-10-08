# Isolamento por vendedor no banco (RLS) — Design

Data: 08/10/2026. Status: aguardando revisão. Origem: dívida técnica 11B da spec de distribuição de leads. Hoje o Márcio (vendedor) lê a carteira, o funil, as mensagens e as tarefas da Marina porque a tela lê direto do Supabase com permissão "por organização".

## 1. Objetivo e escopo

Garantir **no banco** que um vendedor não leia nem altere o que pertence claramente a outro vendedor, inclusive no inbox ao vivo (realtime).

**Dentro do escopo:** políticas RLS por vendedor nas tabelas que a tela lê direto; funções de apoio; interruptor por organização; testes de SQL; verificação ao vivo; rollback por interruptor.
**Fora do escopo:** mudar a distribuição de leads, mexer na carga da carteira, mudar a API/worker (usam chave de serviço, que ignora RLS), regras por produto ou limites por vendedor.

## 2. Decisões já tomadas

| Tema | Decisão |
|---|---|
| Regra | A mesma versão branda aprovada: o vendedor não vê o que é de **outro vendedor**; vê o que é dele, o que está **sem dono** e o que tem dono que **não é vendedor** (conta compartilhada/legado) |
| Gestor | `owner` e `admin` veem e alteram tudo |
| Quem é vendedor | Quem existe em `sales_reps` da organização |
| Sem vendedores | Se a organização não tem nenhum `sales_reps`, ninguém é restringido |
| Interruptor | `organizations.settings.seller_isolation_enabled` (padrão desligado). Com ele desligado, as políticas se comportam como hoje |
| API e worker | Continuam com a chave de serviço (ignoram RLS); o filtro por vendedor já existente na API permanece |
| Caso atual | Com a carga de 08/10 (toda a carteira da Marina), o Márcio deixa de ver 551 negócios e 1.487 conversas |

## 3. Regra de visibilidade (formal)

Para uma linha que pertence à organização `org` e tem "dono" `owner` (pode ser nulo), o usuário logado `u` a vê se **qualquer** uma for verdadeira:
1. o interruptor `seller_isolation_enabled` da organização não está ligado;
2. `u` é `owner` ou `admin` da organização;
3. `owner` é nulo, ou `owner = u`;
4. `owner` **não** está em `sales_reps` da organização (dono legado/conta compartilhada).

Caso contrário (o dono é **outro vendedor**), a linha é invisível e imutável para `u`.

Função central: `public.seller_can_see(p_org uuid, p_owner uuid) RETURNS boolean`, `STABLE`, `SECURITY DEFINER`, `SET search_path = public, pg_temp`. As consultas internas (interruptor, papel, `sales_reps`) usam `auth.uid()` e são avaliadas como subconsultas em cache, para não penalizar tabelas grandes (ver seção 7).

## 4. Quem é o "dono" de cada tabela

| Tabela | Dono usado |
|---|---|
| `conversations` | `assigned_to` |
| `opportunities` | `owner_id` |
| `tasks` | o vínculo mais forte decide: se tem `opportunity_id`, vale o negócio (visível); senão, se tem `conversation_id`, vale a conversa (visível); senão, `seller_can_see(org, assignee_id)` |
| `messages`, `conversation_notes`, `conversation_reads`, `conversation_qualifications`, `conversation_qualification_events`, `handoff_events` | visíveis se a **conversa** for visível |
| `opportunity_events` | visíveis se o **negócio** for visível |
| `task_events` | visíveis se a **tarefa** for visível |
| `wa_contacts` | visível se o contato **não tem nenhuma conversa** ou se alguma conversa dele é visível |

**Armadilha registrada:** uma subconsulta dentro de política também sofre RLS. Para saber se um contato "tem conversa" mesmo que invisível, é preciso uma função `SECURITY DEFINER` (`contact_has_any_conversation(contact_id)`); com `NOT EXISTS` comum, um contato cujas conversas são todas de outro vendedor pareceria "sem conversa" e vazaria.

## 5. Políticas

- **SELECT:** a regra da seção 3/4, sempre combinada com a pertença à organização (`organization_id IN (SELECT get_user_org_ids())`).
- **UPDATE e DELETE:** a mesma condição no `USING` (e no `WITH CHECK` do UPDATE): quem não vê a linha não a altera, e um vendedor não pode "passar" uma linha própria para outro vendedor por UPDATE.
- **INSERT:** permanece como hoje (pertença à organização); o `WITH CHECK` exige só que a linha criada seja visível para quem a criou (dono nulo ou ele mesmo).
- As políticas atuais dessas tabelas são **substituídas** (DROP + CREATE com os mesmos nomes), em uma única migration.
- Tabelas fora da lista (`organizations`, `agents`, `knowledge_*`, `organization_*`, etc.) **não mudam**.

## 6. Interruptor, ativação e reversão

1. A migration cria as funções e as políticas; com o interruptor ausente/desligado nada muda para ninguém.
2. Deploy e testes ao vivo **com o interruptor desligado** (regressão: inbox, funil e tarefas iguais a hoje).
3. Ligar `seller_isolation_enabled` para a organização (por SQL ou pela tela de Configurações) e verificar ao vivo com o login do Márcio, da Marina e do gestor.
4. **Rollback:** desligar o interruptor. Nenhum dado é apagado ou alterado.

## 7. Desempenho

- As verificações do interruptor, do papel e da lista de vendedores são subconsultas de resultado constante por consulta (avaliadas uma vez, não por linha).
- `messages` é a tabela mais pesada: a política usa `EXISTS` pela chave primária de `conversations` (já indexada). Requisito de aceite: `EXPLAIN` de `SELECT` típico do inbox (últimas mensagens de uma conversa e lista de conversas) sem varredura sequencial nova e sem regressão de tempo perceptível com 100 mil mensagens de teste.
- Índices necessários (confirmar no plano): `sales_reps (organization_id, user_id)` já único; `conversations (assigned_to)`, `opportunities (owner_id)`, `tasks (assignee_id)` se faltarem.

## 8. Realtime

O Supabase Realtime aplica RLS com o JWT do usuário: o vendedor só recebe eventos de linhas visíveis. Requisito de aceite: com o interruptor ligado, o Márcio não recebe eventos de `messages`/`conversations` da Marina (verificação ao vivo na seção 10).

## 9. Testes (PGlite, como nas migrations de distribuição)

Cenários por tabela, com `SET ROLE authenticated` e `auth.uid()` simulado:
- Gestor vê e altera tudo.
- Marina (vendedora) vê o que é dela e o sem dono; **não** vê nem altera o que é do Márcio; Márcio idem.
- Dono legado (conta compartilhada, não vendedor): visível para os dois vendedores.
- Usuário `agent` que **não** está em `sales_reps`: visível o que é sem dono/legado, não o de vendedores.
- Organização sem `sales_reps`: ninguém restrito.
- Interruptor desligado: tudo visível como hoje.
- Dependentes: mensagens, notas, qualificações, handoffs, eventos de negócio e de tarefa seguem a visibilidade do pai.
- `wa_contacts`: a armadilha da seção 4 (contato só com conversas de outro vendedor não vaza; contato sem conversa é visível).
- Tarefa: precedência negócio > conversa > responsável.
- UPDATE que tenta transferir linha própria a outro vendedor é rejeitado.
- Outra organização nunca é visível (regressão do isolamento entre organizações).

## 10. Verificação ao vivo (depois do deploy, com o interruptor ligado)

Com o login do **Márcio**: inbox, funil e tarefas **não** mostram dados da Marina; contagens batem (só sem dono). Com o login da **Marina**: continua vendo a carteira dela. Com o login do **gestor**: vê tudo. Inbox em tempo real do Márcio não recebe mensagens da Marina.

## 11. Riscos

| Risco | Mitigação |
|---|---|
| Regressão no inbox por junção com tabela restrita | testes de SQL + verificação ao vivo antes de ligar; interruptor desligado no deploy |
| Lentidão por política em `messages` | requisito de `EXPLAIN` e carga de teste (seção 7) |
| Vazamento por subconsulta com RLS (contato) | função `SECURITY DEFINER` e teste específico |
| API/worker dependem de ler tudo | usam chave de serviço (ignora RLS); testes existentes continuam passando |
| Vendedor "preso" sem ver o que precisa | regra inclui sem dono e dono legado; gestor reatribui |
| Alguém precisar enxergar tudo | gestor (`owner`/`admin`) ou desligar o interruptor |

## 12. Ativação e reversão (resumo)
Aplicar a migration (desligada) → deploy → testes ao vivo → ligar o interruptor → verificar → se algo falhar, desligar. A migration não apaga nem altera dados.

## 13. Pontos abertos
Nenhum. Premissa a confirmar: o usuário que a Marina e o Márcio usam são os `agent` já cadastrados em `sales_reps`, e o login do gestor (owner) é o da conta atual.
