# Registro de ligações e comparação de estratégias

Aprovado pelo usuário em chat (2026-10-12). Objetivo: o vendedor (Márcio) registra cada ligação em um clique; o gestor compara "mensagem antes de ligar" x "só ligar" (atendimento, proposta/visita, ganho). Inclui separação visual dos botões do detalhe do card.

## Tabela `sales_call_logs` (migration `20261012120000_sales_call_logs.sql`)
- id uuid pk; organization_id; opportunity_id (FK opportunities ON DELETE CASCADE); contact_id; rep_user_id uuid (quem ligou, auth.users); strategy text CHECK in ('message_first','call_only'); suggested_strategy text (mesmos valores; o que o sistema sugeriu); outcome text CHECK in ('answered','no_answer','callback','no_interest','wrong_number'); note text null; called_at timestamptz default now(); created_at.
- Índices: (organization_id, called_at), (opportunity_id).
- RLS ligada. SELECT/INSERT: organização do usuário E a oportunidade visível ao usuário. Siga EXATAMENTE o padrão do isolamento por vendedor já existente (supabase/migrations/20261008120100_..., 20261008120200_...: `organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = sales_call_logs.opportunity_id)`). Sem UPDATE/DELETE para usuários.
- Teste PGlite no estilo packages/database/src/sql/seller-isolation-*.test.ts (rls-fixture/rls-harness): Márcio não vê logs de leads da Marina; gestor vê todos; outra organização nunca.

## API (apps/api, Fastify, padrão de apps/api/src/routes/opportunities)
- `POST /opportunities/:id/call-logs` {strategy, outcome, note?} → exige membro da org e `canViewLead` (apps/api/src/lib/lead-access.ts) sobre o dono da oportunidade; grava com service client, rep_user_id = request.user.id, suggested_strategy calculado no servidor; devolve o registro. 
- `GET /opportunities/:id/call-logs` → registros do lead (mesma checagem).
- `GET /organizations/:organizationId/call-report?from=YYYY-MM-DD&to=YYYY-MM-DD` → só owner/admin; por estratégia: calls, answered, answeredRate, leads distintos, leadsWithProposalOrVisit (oportunidade cujo stage chegou a etapa de proposta/visita — usar FUNNEL_STAGES de packages/shared; decida o conjunto de etapas "avançadas" lendo o código e documente), won, wonRate (opportunities.status='won' entre os leads com ligação registrada), e noInterest por motivo se existir (outcome=no_interest agrupado; motivo vem da nota? não: apenas contagem de outcomes). Também por vendedor.
- Função pura `suggestCallStrategy(opportunityId): 'message_first'|'call_only'` em packages/shared (último dígito hexadecimal par → message_first, ímpar → call_only), com teste.
- Testes vitest da API para as 3 rotas (permissões: vendedor não registra em lead de outro vendedor; não-gestor recebe 403 no relatório; relatório agrega certo).

## Web (apps/web)
1. Detalhe do card (`components/opportunities/opportunity-detail-dialog.tsx`): botão **Registrar ligação** abre um diálogo: mostra "Sugestão para este lead: …" (mensagem antes e depois ligar / ligar direto), escolha da estratégia usada (pré-selecionada na sugerida), resultado (5 opções em português: Atendeu, Não atendeu, Pediu retorno, Sem interesse, Número errado), observação opcional; salva via POST; lista as ligações anteriores do lead no detalhe. Se resultado for "Pediu retorno" ou "Não atendeu", oferecer link/ação para criar tarefa de retorno usando o fluxo de tarefas já existente (se não for trivial, apenas texto lembrando de criar a tarefa — não construa fluxo novo).
2. **Separação visual** da fila de botões do detalhe, em três grupos com rótulo discreto:
   - "Atendimento": Abrir conversa / Abrir no WhatsApp / Registrar ligação — destaque de cor primária (sólidos, com ícone).
   - "Avançar negócio": Marcar como ganho (verde sólido, ícone check) e Marcar como perdido (vermelho, ícone X) — maiores e visualmente separados, à direita ou em bloco próprio com borda.
   - "Gerenciar": Editar dados, Congelar, Mover para outro funil — `variant="ghost"`/discretos, menores.
   Mantenha acessibilidade (rótulos de texto, foco visível) e o tema claro/escuro. Não altere comportamentos.
3. Página nova `app/(dashboard)/calls/page.tsx` ("Ligações"), só gestor (esconder item no menu `components/layout/app-sidebar.tsx` para não-gestores; a API já bloqueia): seletor de período (padrão 30 dias), tabela comparativa por estratégia (ligações, % atenderam, % proposta/visita, % ganhos) e por vendedor, nota explicando amostra pequena (<30 por grupo).
4. Textos em português; sem mencionar Marina/Mariana em rótulos.

## Restrições
- Não aplicar migration em produção; não fazer push de merge; apenas commits locais na branch feat/call-log (push permitido na branch, SEM abrir PR).
- Testes: `pnpm --filter @aula-agente/database exec vitest run`, `pnpm --filter @aula-agente/api exec vitest run`, tsc de api/web/shared/database; `next build` com NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy.
- Commits terminam com: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
