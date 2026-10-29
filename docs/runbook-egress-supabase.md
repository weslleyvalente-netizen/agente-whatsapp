# Runbook: egress do Supabase (funil de vendas)

## O que foi medido

- Egress em torno de 1,2 GB/dia (limite grátis: 5 GB/mês) e site lento.
- A tela do funil (`/opportunities`) atualiza a cada 30 s (mais realtime, com throttle de 15 s) e chama
  `GET /organizations/:organizationId/opportunities` e `.../opportunities/pending-tasks`.
- Cada chamada baixava a organização inteira: conversas open/waiting com a última mensagem (1.743 linhas, ~663 KB,
  só 652 de contatos com negócio aberto), handoffs, tarefas (94), negócios abertos, e (com distribuição de leads)
  `sales_reps` e `lead_assignments`. A lista de negócios vinha com `select=*` (~802 KB para 652 negócios abertos).

## O que mudou

1. Cache por organização no servidor (`apps/api/src/lib/org-cache.ts`, usado em
   `apps/api/src/services/sales-workspace.service.ts`):
   - TTL de 20 s, em memória, uma entrada por organização.
   - Chamadas simultâneas na mesma organização compartilham a leitura em andamento (várias abas / vários usuários).
   - Erro de leitura nunca é guardado; a chamada seguinte tenta de novo.
   - Cacheia só insumos brutos da organização: conversas dos contatos com negócio aberto, handoffs pendentes,
     tarefas abertas, negócios abertos (`id,contact_id`), `sales_reps`, `lead_assignments` ativos e, para
     `pending-tasks`, as tarefas completas e as conversas dos contatos dessas tarefas.
   - Nunca cacheia o resultado por usuário: visibilidade/viewer (`applyLeadDistribution`, `isLeadVisible`) e o
     `sales_state` de cada card continuam sendo calculados a cada requisição.
   - Teste: `resetSalesWorkspaceCacheForTests()`.
   - Consequência: tarefas, handoffs e atribuições podem aparecer até 20 s atrasados no funil (o `contactCache` de
     contato humano/ligações, de 60 s, já existia).
2. Conversas só dos contatos que importam: em vez de todas as conversas open/waiting da organização, busca-se por
   `.in("contact_id", lote de 100)` apenas as dos contatos com negócio aberto (mesmo conjunto para todos os usuários,
   por isso continua cacheável). Linhas de outras listas (ganhos/perdidos) cujo contato não está nesse conjunto têm a
   conversa buscada à parte, sem cache. Em `pending-tasks`, só os contatos das tarefas sem negócio aberto.
   O estado dos cards é idêntico: conversa de contato sem negócio aberto não altera nenhum card.
3. Colunas explícitas na lista do funil (`OPPORTUNITY_LIST_COLUMNS` em
   `packages/database/src/queries/opportunities.ts`). Ficaram de fora apenas `freeze_previous_pendency`,
   `freeze_previous_waiting` (jsonb usados só pelas funções SQL de congelamento) e `frozen_at`. O detalhe completo
   continua em `GET /opportunities/:id/details` (`select *`).

## Como validar no painel do Supabase

1. Dashboard do projeto > Reports > Database (ou Settings > Usage) > Egress. Compare o consumo diário nos dias
   anteriores ao deploy com os dias seguintes.
2. Em Logs > API (PostgREST), filtre por `conversations?select=id,contact_id,last_message_at` e confirme que as
   consultas agora trazem `contact_id=in.(...)` com até 100 ids, e que a frequência caiu (no máximo uma leitura por
   organização a cada ~20 s, independentemente de quantas pessoas/abas estão abertas).
3. Confira também `opportunities?select=*,wa_contacts(...)`: não deve mais aparecer; a lista usa colunas explícitas.
4. Estimativa: antes ~1,5 MB por refresh por aba (802 KB de negócios + ~663 KB de conversas + extras). Agora, no
   pior caso, uma leitura de insumos a cada 20 s por organização (conversas ~250 KB, só dos 652 contatos) mais a lista
   de negócios (um pouco menor) por requisição.

## Invalidação por escrita

Para o vendedor não ver dado antigo por até 20 s depois de agir, `apps/api/src/server.ts` registra um hook
`onSend` (antes de a resposta chegar ao cliente, o que fecha a corrida com o refetch da tela) que chama
`invalidateSalesWorkspaceCacheOnWrite`: toda requisição POST/PUT/PATCH/DELETE descarta os caches de insumos da
organização (`params.organizationId` ou `query.organizationId`), exceto respostas 401/403/404 (um erro parcial 400/500
pode ter gravado antes de falhar). Se a rota não expõe a organização (ex.: `/lead-assignments/:id/accept`,
`/opportunities/:id/...`), descarta os de todas as organizações do usuário (`request.user.memberships`); o custo é só
uma releitura. Requisições sem usuário e sem organização não invalidam.

O webhook da Evolution (`routes/webhooks/evolution.ts`) roda no processo da API e invalida a organização depois de
gravar a mensagem do cliente (e o eco do celular), para o realtime do funil não reler o cache velho.

Cards recém-criados por worker: a contagem de negócios abertos por contato usa o cache mais as linhas abertas da
própria resposta (uma linha fechada tira o negócio da contagem), e as conversas de contatos fora do cache são buscadas
à parte. As pendências sem negócio leem `opportunities(id,contact_id)` direto, junto com as tarefas.
As buscas de conversas rodam em lotes de 100 ids, no máximo 3 consultas simultâneas.

## Limites conhecidos

- Cache e invalidação são em memória por processo: valem com 1 réplica da API. Com mais de uma, uma réplica não vê a
  invalidação da outra e o dado pode ficar até 20 s atrasado.
- Escritas feitas pelo worker não invalidam (até 20 s de atraso é aceito).
- `recover-messages` (rota admin) responde antes de concluir o trabalho, então o dado recuperado pode ficar até
  20 s velho no funil.
