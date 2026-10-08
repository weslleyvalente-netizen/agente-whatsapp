# Runbook: distribuição de leads (rodízio)

Spec: docs/superpowers/specs/2026-10-07-lead-distribution-design.md

## Antes de ligar (modo sombra e depois a distribuição real)
1. Migrations aplicadas (`supabase migration list` deve mostrar as quatro de 20261007 como aplicadas). Só aplicar com autorização: `supabase db push`.
2. Deploy de API, worker e web concluído e saudável. O log do worker mostra "Lead-sla worker started (runs every 60 s)".
3. A flag `lead_distribution_enabled` está ausente/false: nada mudou para os usuários.
4. Márcio convidado como membro `agent` da organização.
5. Criar os vendedores (SQL no editor do Supabase, trocando os UUIDs pelos `user_id` reais dos membros):
   insert into sales_reps (organization_id, user_id, display_name, rotation_order) values
     ('<org>', '<user_marina>', 'Marina', 1), ('<org>', '<user_marcio>', 'Márcio', 2);
6. Conferir o calendário comercial (padrão segunda a sexta 08:00–18:00). Se houver atendimento aos sábados, gravar `settings.business_calendar` com uma janela de sábado (ex.: 08:00–12:00).
7. Ao ligar `lead_distribution_enabled` pela tela, o sistema grava `lead_distribution_activated_at`; se a flag for ligada por SQL, grave `lead_distribution_activated_at` junto, senão handoffs antigos entram.

## Carga da carteira existente (uma vez, antes do modo sombra)
Regra do negócio: **toda a carteira que já existe fica com a Marina; só lead novo entra no rodízio.**
1. Convide Marina e Márcio como membros `agent` (tela Equipe) e espere os dois aceitarem.
2. Cadastre os dois em `sales_reps` (passo 5 de "Antes de ligar"), com `rotation_order` 1 (Marina) e 2 (Márcio).
3. Simule (somente leitura), a partir da raiz do repositório:
   `node --env-file=.env --experimental-strip-types packages/database/scripts/assign-legacy-leads.ts --organization=<id> --rep-user=<user_id da Marina>`
   Confira as contagens (oportunidades abertas, conversas, tarefas) antes de gravar.
4. Grave só depois de conferir e com a migration 20261007120000 aplicada:
   `... --rep-user=<user_id da Marina> --apply --confirm=<id da organização>`
   O script só altera onde não há dono vendedor (vazio ou conta compartilhada), não cria atribuições nem SLA, e registra um evento `owner_changed` por oportunidade. Use `--only-active` para limitar às conversas `open`/`waiting`.
5. Um cliente antigo que voltar com um novo handoff continua com a Marina (dono existente); quem nunca teve dono entra no rodízio.

## Modo sombra (obrigatório antes de ligar)
1. Configurações → Distribuição → ligar **"Modo de teste (simulação)"** (`lead_distribution_shadow_enabled`). Nada real muda: cada handoff novo só gera uma linha em `lead_distribution_shadow_log` com quem receberia e por quê.
2. Deixe rodar com handoffs reais por alguns dias (mínimo sugerido: 20 handoffs ou 2 dias úteis).
3. Valide com as consultas abaixo. Critérios para ligar a distribuição real:
   - **Alternância:** entre os `round_robin`, Marina e Márcio ficam dentro de ±1 um do outro.
   - **Dono existente:** os `existing_owner` apontam o vendedor que de fato já atende aquele cliente; nenhum cliente da Marina aparece indo ao Márcio.
   - **Calendário e prazo:** `sla_due_at` nunca cai de madrugada, no domingo, em feriado ou período fechado. Um handoff às 17:50 de sexta aparece com prazo na segunda de manhã.
   - **Exceções:** só aparecem `no_available_rep` quando de fato não havia vendedor disponível; nenhum `invalid_existing_owner` ou `manual_review` inesperado (investigar cada um).
4. Limitação do modo sombra: como ele não grava dono, o segundo handoff do mesmo cliente durante a simulação aparece como `round_robin`. Isso é esperado.
5. Consultas:
   - Quem receberia: `select would_rep_name, reason, exception_reason, sla_action, sla_due_at, handed_at from lead_distribution_shadow_log order by created_at desc;`
   - Alternância: `select would_rep_name, count(*) from lead_distribution_shadow_log where reason='round_robin' group by 1;`
   - Exceções: `select exception_reason, count(*) from lead_distribution_shadow_log where reason='exception' group by 1;`
6. Se algo falhar, desligar o modo sombra, corrigir e repetir. Sem a validação aprovada **não ligar** `lead_distribution_enabled`.

## Ligar
Desligue o modo sombra e ligue a distribuição em Configurações → Distribuição. O sistema grava `lead_distribution_activated_at`; só handoffs a partir daí entram. A base existente NÃO é redistribuída.

## Validar com handoffs reais (um de cada tipo)
- Rodízio: dois handoffs seguidos vão a vendedores diferentes; o card mostra o vendedor e a contagem regressiva.
- Assumir: o botão "Assumir lead" ou a primeira mensagem do vendedor registram `accepted_at`; a mensagem da Mariana NÃO assume.
- SLA (lead novo do rodízio): um lead não assumido é redistribuído ao outro vendedor em até ~1 minuto depois do vencimento (dentro do horário comercial). Para testar sem esperar 15 minutos, reduza `lead_sla_minutes` para 5 num teste controlado e volte para 15 depois.
- Dono existente: cliente que já é do Márcio volta para ele, sem andar o rodízio. Se ele passar do prazo, o card mostra "Atraso de resposta" e o gestor vê o alerta, mas o cliente **continua com o Márcio** (não há redistribuição automática).
- Alertas: com um cliente que já tem vendedor e passou do prazo, confira o painel de alertas e o selo "Atraso de resposta" no card; o cliente não troca de vendedor.
- Exceção: com os dois pausados, o handoff aparece em "Leads sem responsável".
- Pausar: um vendedor Pausado não recebe novos leads e mantém os atuais. Fora da distribuição não move nenhum lead.

## Consultas úteis
- Tempo handoff → primeira resposta: `select * from lead_response_metrics order by assigned_at desc limit 50;`
- SLAs estourados por vendedor: `select rep_id, count(*) from lead_assignments where sla_breached group by rep_id;`
- Exceções abertas: `select * from lead_assignments where status='exception' and resolved_at is null;`

## Reversão
Desligar `lead_distribution_enabled` em Configurações → Distribuição. O histórico permanece, os leads continuam com seus donos e o `requestHuman` volta a usar o responsável padrão de handoff. Nenhum dado é apagado.

## Limites conhecidos e dívida técnica explícita (fase 1)
- O isolamento por vendedor é da aplicação (API e telas), não do banco. Inbox, realtime e a página de tarefas leem direto do Supabase e só têm filtro de tela. Etapa futura própria: RLS por vendedor, com spec própria.
- A visibilidade é a versão branda: o vendedor não vê o que pertence claramente ao outro vendedor; lead sem dono e carteira antiga continuam visíveis. A migração/saneamento da carteira antiga e o endurecimento do isolamento ficam para uma etapa específica.
- `last_commercial_activity_at` só é atualizada por mensagem humana; mudança de etapa e tarefa concluída não atualizam (decisão da fase 1).
- Reatribuição em lote da carteira não existe (ação administrativa futura e explícita).
- Aviso de exceção é só painel e contador (sem e-mail ou push).
- `lead_assignments` é histórico imutável: excluir um agente, uma instância do WhatsApp ou uma organização que já tenha histórico de distribuição é bloqueado por chaves estrangeiras (comportamento intencional). O modo sombra não bloqueia exclusões (o log de simulação é removido em cascata).
- O SLA de 15 minutos redistribui automaticamente só lead novo do rodízio; cliente que já tem vendedor (e reatribuição manual do gestor) só gera alerta de atraso, nunca muda de vendedor sozinho.
