# Cutucar cliente com tarefas consolidadas por negócio

## O que mudou
- Com `task_consolidation_by_opportunity_enabled=true` o cutucar deixou de ser bloqueado: vira **uma pendência** (`customer_nudge`) dentro da tarefa consolidada do negócio, pelo mesmo `createTaskWithDedup` (sem tarefa paralela). Sem tarefa aberta, nasce uma tarefa normal.
- **Responsável:** ao agrupar, a tarefa passa para o **dono atual do negócio** (`assign_on_merge`), com evento `assigned` — cobre transferência entre vendedores. Prazo, motivo e prioridade ficam na pendência.
- **Toques:** cada toque grava um evento `customer_nudge_touch` (nota com `nudge-conv:<conversa>`). A contagem não depende da pendência continuar na lista; tarefas legadas do tipo `customer_nudge` continuam contando.
- **Encerramento:** resposta do cliente e mensagem do vendedor removem **apenas** a pendência `customer_nudge` (só as criadas antes da mensagem); as demais obrigações da tarefa seguem abertas. Se era a única, a tarefa conclui.
- **Calendário:** a régua de "1 dia útil" é o dia mais longo do calendário da organização (`businessDayMinutes`; Moto e Trilha = 630 min, não 600).
- **Push:** um por toque (`nudge:<taskId>:<toque>`).
- **Aguardando/próxima ação** (`waiting_on_sync_enabled`, desligado): só as transições comprovadas descritas em `packages/shared/src/waiting-on-sync.ts`.

## Chaves (`organizations.settings`) — todas só `=== true` / valor explícito, ausentes = comportamento anterior
| Chave | Efeito |
|---|---|
| `customer_nudge_consolidated_enabled` | Liga o cutucar quando a consolidação está ligada. **Sem ela a org continua pulada** (nada dispara na implantação). |
| `customer_nudge_baseline_at` (ISO) | Só conta mensagem do vendedor enviada a partir desse instante. Anteriores = histórico (`before_baseline`). |
| `customer_nudge_max_new_per_run` (1–100) | Teto de pendências novas por execução de 30 min. Padrão 25. |
| `waiting_on_sync_enabled` | Liga a sincronização comprovada de `waiting_on`/próxima ação. |

## Ativação gradual (nenhum passo é automático)
1. Implantar com as chaves ausentes: o log segue mostrando `skipped={"consolidation_not_activated":1}`.
2. Ativar: `customer_nudge_consolidated_enabled=true` + `customer_nudge_baseline_at=<agora>` + `customer_nudge_max_new_per_run=5`. Só mensagens novas entram.
3. Recuperar histórico por ondas **baixando o corte** (ex.: 12/11, 07/11…) conforme a revisão comercial, sempre com teto baixo. Ver priorização no PR.
4. Reverter: apagar `customer_nudge_consolidated_enabled` (ou subir o corte) — as pendências abertas continuam e se resolvem normalmente.

## Observabilidade
Log a cada 30 min: `customer-nudge: orgs=1 opps=<abertos> evaluated=<conversas avaliadas> created=<novas> grouped=<entraram em tarefa consolidada> resolved=<encerradas> pushed=<push> errors=<n> skipped={motivo:n}`.
Motivos de regra: `not_seller_last, no_owner, too_old, before_baseline, outside_business_hours, max_touches, open_task, frozen, waiting_scheduled, waiting_on_us, customer_refused, not_due_yet, nudge_interval`. Ambiente: `consolidation_not_activated, run_cap, task_already_open`.
