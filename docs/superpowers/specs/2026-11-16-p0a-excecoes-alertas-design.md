# P0a: triagem de exceções de SLA e alertas 0/15/30/60 min úteis

Status: implementado em branch para REVISÃO. Nada aplicado em produção; tudo desligado por padrão.
Escopo aprovado em 16/11/2026. O botão "Assumir" (P0b) NÃO está neste PR: ver `2026-11-16-p0b-assumir-excecao-proposta.md`.

## 1. O que muda (e o que não muda)
| Item | Comportamento |
|---|---|
| Classificação | Cada exceção (e cada atribuição `alert` vencida) vira: **aguardando atendimento comercial**, **respondida sem aceite formal**, **resolvida** (evento auditável) ou **obsoleta** (só `alert`). Função pura `classifyTriage` em `packages/shared/src/exception-triage.ts`. |
| Resposta comercial | `classifyHumanReply`: saudação/cortesia (até 2 palavras além da saudação) não conta; **áudio/mídia nunca conta** (conteúdo não verificável, erro seguro). Cortesia de encerramento do cliente ("blz", "obrigada") não conta como cliente esperando **se já houve resposta humana**. |
| Atraso | Âncora = **primeiro handoff da cadeia** (`handoff_at`); a criação da exceção não zera nada. Mostrado em minutos úteis e corridos. |
| Painel | Atrás de `exception_triage_panel_enabled`: Urgentes / Respondidas (falta confirmar quem assumiu) / Obsoletas. Rótulos separados: **Cutucar vendedor** (push interno, nunca ao cliente) × follow-up automático ao cliente (só informativo). Desligado = painel antigo idêntico. |
| Alertas | Worker novo, escada 0, 15, 30, 60 min úteis a partir da criação da exceção. Atrás de `exception_alerts_mode` (`off`/`shadow`/`on`) **e** `exception_alerts_activated_at`. Livro com índice único (exceção, estágio, canal, destinatário) = idempotência, e o plano é calculado **por destinatário** (seção 9). |
| Sem retroativo | Exceção criada antes de `exception_alerts_activated_at` nunca avisa. Ligar a chave não dispara nada sobre o passado. |
| Cancelamento | Evento `resolved_*` OU exceção encerrada por outro caminho (`resolved_at`, p.ex. `manual_assign`) interrompe a escada. Reconhecer NÃO cancela. Resposta pelo celular NÃO resolve. |
| Resolução | `record_exception_event` (SQL atômica, idempotente): `acknowledged`, `resolved_confirmed` (exige vendedor), `resolved_no_action` (exige nota). Tabela **append-only**. **Não escreve em `lead_assignments`**: o histórico original (handoff, SLA, responsável) fica intacto. |
| Rodízio | Nenhuma linha toca `lead_distribution_state`, `rotation_order` ou `distribute_lead`. Testes comparam snapshot de `lead_assignments`, ponteiro e vendedores antes/depois. |
| Evolution | Nenhuma alteração em conexões/instâncias. |

## 2. Auditoria de segurança (política de acesso) — achados comprovados em 16/11
Lido em produção (somente leitura: `pg_policies`, privilégios de coluna) e fixado em teste (`exception-triage-rls.test.ts`):
1. **`org_select`**: qualquer membro da organização (inclusive `agent`) pode `SELECT` a linha inteira de `organizations`, incluindo **`settings`** (`health_alert_phone`, `handoff_notification_phone`, e qualquer chave futura). `authenticated` tem `SELECT` na coluna `settings`. Um vendedor, com o próprio JWT, obtém esses dados.
2. `organization_members` e `sales_reps` também são legíveis por qualquer membro (lista de usuários da equipe).
3. `push_subscriptions` é protegida por dono (ok). `lead_assignments` tem isolamento por vendedor (ok).
4. Só existem os papéis `owner` e `agent` em uso; o gestor hoje é um único login **compartilhado** (`weslley`, owner, sem dispositivo de push).
**Consequência de desenho:** destinatários dos alertas **não** ficam em `settings`. Ficam em `exception_alert_recipients` (RLS ligada, sem policy, `REVOKE` de `anon/authenticated`): só service role. Sem lista configurada, **ninguém além dos vendedores** é avisado: não há fallback para "todos os owners/admins".
**Fora do escopo deste PR, recomendado:** mover `health_alert_phone` e `handoff_notification_phone` para tabela só de gestor e restringir `settings` por coluna/visão. Mudança ampla (a web lê `settings` no cliente); proposta separada.

## 3. Tabelas, permissões e migração (NÃO aplicada)
Arquivo: `supabase/migrations/20261127130000_exception_triage_alerts.sql` (só objetos novos, idempotente, com bloco de ROLLBACK no cabeçalho).
- `exception_events` (append-only por gatilho; índice único: 1 resolução por exceção; checks: `resolved_confirmed` exige `rep_id`, `resolved_no_action` exige nota).
- `exception_alert_ledger` (índice único (assignment_id, stage, channel, recipient)).
- `exception_alert_recipients` (gestores explícitos).
- função `record_exception_event(...)`: `SECURITY DEFINER`, trava **somente** a linha da exceção (sem ciclo com `distribute_lead`/`redistribute_assignment`/`manual_assign`, que travam `lead_distribution_state` primeiro).
- Permissões: `REVOKE ALL` de `anon, authenticated` nas 3 tabelas e `EXECUTE` da função; `GRANT` só a `service_role`.
Ensaio feito: PGlite com as migrações reais + `createRealSchemaDb` (`failedMigrations = []`).

## 4. Concorrência (revisão)
- Dois workers/reinício: o **INSERT** no livro é a reserva; violação `23505` = outro processo já reservou. Testado (fila em memória + índice real).
- Falha de envio libera a reserva (nada foi entregue) e o ciclo seguinte tenta de novo; "sem aparelho" fica registrado como `skipped` (não repete a cada minuto); push não configurado não consome o estágio.
- Reserva presa após 5 min (`releaseStaleAlertClaims`): **sem** `send_started_at` (caiu antes de chamar o push) é apagada e reenviada; **com** a marca (o push pode ter saído) vira `skipped`/`unconfirmed_send` e **nunca** é reenviada. Nunca toca `sent`/`skipped`. Ver seção 9.
- Worker parado: envia **só o estágio mais alto vencido** e registra os anteriores como `skipped` (sem enxurrada).
- Kill switch relido a cada envio: desligar interrompe um ciclo em andamento. `EXCEPTION_ALERTS_DISABLED=1` impede até criar o timer (exige reinício).
- Limitação conhecida: o PGlite é de conexão única; a corrida real entre duas conexões é garantida pelo índice único e pela trava de linha, e testada por semântica (violação de unicidade), não por paralelismo.

## 5. Como ativar com segurança (nada disso foi feito)
1. Autorização explícita do dono e revisão do PR; aplicar a migração em cópia e depois em produção.
2. Cadastrar o gestor individual (usuário e dispositivo: depende do e-mail que o dono informará) em `exception_alert_recipients`.
3. `exception_triage_panel_enabled = true` (só painel; sem envio).
4. `exception_alerts_activated_at = <agora>` + `exception_alerts_mode = "shadow"`: **5 dias úteis** registrando "o que enviaria" no livro (`channel = 'shadow'`).
5. Comparar a sombra com a realidade (consulta no PR): 100% das exceções novas com estágio 0 registrado; 0 duplicata; 0 estágio fora da escada; 0 exceção antiga avisada.
6. Só então `exception_alerts_mode = "on"` (push). E-mail e monitor externo são fases seguintes (seção 7).
**Rollback:** `exception_alerts_mode = "off"` e `exception_triage_panel_enabled = false` (efeito em 1 ciclo); se necessário, o script de rollback do cabeçalho da migração remove só os objetos novos.

## 6. Identidade administrativa individual (plano, nada criado)
- Criar um usuário individual (e-mail só do dono) com papel `admin` (ou `owner`), logado só no dispositivo pessoal; cadastrar push **depois** de logar com ele.
- Adicionar o `user_id` dele a `exception_alert_recipients` (e só ele). O login compartilhado da loja **não** entra.
- Alertas sem nome/telefone/texto de cliente; o link exige login.
- Antes de criar: decidir a correção do achado 1 (seção 2), porque um `admin` novo também é membro e hoje leria `settings`.

## 7. Monitor externo (proposta; não implementado neste PR)
**Nível 1, liveness público e mínimo:** `GET /health/live` → `200 {"status":"ok"}`, sem versão, sem dependências, sem dados da organização, com limite de taxa. Sondado por serviço **fora** do servidor monitorado (ex.: UptimeRobot/Better Stack/Healthchecks.io) a cada 1 min; avisa por e-mail/SMS do próprio serviço (independente do WhatsApp e do VPS). O `/health` atual já é mínimo (`status` + hora).
**Nível 2, diagnóstico operacional autenticado:** `GET /health/diagnostic` com token de monitoramento dedicado (Bearer, só leitura, rotacionável; nunca o JWT de usuário): API, banco, Redis, profundidade/falhas das filas (BullMQ), "batimento" dos workers (última varredura do SLA e dos alertas), e por instância Evolution: estado **e** último recebimento no Evolution × último no CRM (detecta "Connected mas sem receber"; os dados já são coletados por `evolution_connection_observations`).
**Fora da infraestrutura monitorada, modelo "dead-man's switch":** o worker/API envia um batimento (HTTP GET a URL secreta do serviço externo) a cada 5 min **somente se o diagnóstico estiver saudável**. Se a API cair, o Redis travar ou o Evolution ficar surdo, o batimento para e o serviço externo avisa por e-mail/SMS. Assim o alerta nunca depende do mesmo WhatsApp/servidor. Credenciais do serviço: do dono.

## 8. O que ainda falta para ativar
Aprovação do PR; aplicar migração; e-mail do gestor individual + usuário + push; corrigir/decidir o achado de `settings`; 5 dias úteis de sombra; canal e-mail (provedor transacional + DNS) e monitor externo (itens da seção 7); P0b em PR próprio. Sem esses passos a funcionalidade permanece inerte.

## 9. Correções da revisão do PR #102 (commit seguinte ao a3b8735)
1. **Controle individual por destinatário.** O planejador roda uma vez por destinatário, só com as linhas do livro dele. Quem não recebeu (falha, reserva solta) continua elegível no ciclo seguinte mesmo que outro já tenha recebido aquele estágio. Vendedor nunca recebe o 60 (`recipientEligibleStages`); estágios atrasados de cada pessoa viram `skipped` por pessoa. Erro de um destinatário não interrompe os demais.
2. **Shadow -> on sem suprimir.** Linhas `shadow` só contam no modo shadow; no modo on contam `push`/`email`/`skipped`. Ligar o `on` envia, por destinatário, o estágio mais alto devido (sem enxurrada) para exceções criadas depois da ativação e ainda abertas. A sombra não ocupa o slot do envio real (canal diferente no índice único). `on -> shadow -> on` não reenvia.
3. **Sem push duplicado entre envio e confirmação.** Sequência: reservar (INSERT único) -> gravar `send_started_at` -> chamar o push -> confirmar (3 tentativas). Se a marca não grava, o push NÃO é chamado. Se a confirmação falha 3 vezes, a reserva fica marcada e é convertida em `skipped`/`unconfirmed_send` pela varredura (nunca reenviada, `summary.unconfirmed` e log de erro). Premissa: preferir um aviso possivelmente já entregue a um duplicado; o próximo estágio da escada continua valendo. O `tag` do push também colapsa um eventual duplicado no aparelho. Limitação residual: se a soltura da reserva falhar depois de um push que falhou, aquele estágio daquele destinatário é perdido (o seguinte segue).
4. **"Sem ação necessária" com cliente aguardando.** O servidor relê o estado e responde 409 se `clientWaiting`, salvo **justificativa de lista fechada** (`cliente_atendido_fora_do_crm`, `cliente_pediu_para_aguardar`, `contato_invalido_ou_duplicado`, `cliente_desistiu`) **e** nota de 20+ caracteres; a justificativa é gravada na nota do evento append-only. Reconhecer e "confirmar quem assumiu" não são bloqueados. A tela espelha a regra, mas a decisão é do servidor. Corrida residual: cliente que escreve entre a releitura e a gravação (milissegundos) não é detectado.
5. **Prontidão antes de ativar.** `evaluateAlertReadiness`: push configurado + pelo menos um destinatário da lista explícita que seja **membro atual com papel owner/admin e tenha aparelho push**. Modo `on` sem prontidão **não envia nem consome estágio** (log + `notReady`); ao corrigir, o estágio devido sai. Só destinatários owner/admin entram como "gestor" (vendedor na lista nunca recebe o crítico). Falha ao avaliar = não pronto. No modo shadow o ledger registra `ready: true|false`, e o painel mostra aviso com os motivos. Canal e-mail continua fora deste PR; "canal funcional" aqui = push com aparelho cadastrado (não há teste de entrega real sem enviar aviso).
Migração: acrescentada a coluna `send_started_at` ao `exception_alert_ledger` (ainda não aplicada em lugar nenhum).

## 10. Resultado ambíguo do push (ensaio do C1) e observabilidade
- **Regra:** a reserva só é liberada para nova tentativa com EVIDÊNCIA de que nada foi entregue. `classifyPushError` (testado com o `webpush.sendNotification` real e só o transporte simulado): 404/410 = assinatura expirada (removida); 4xx exceto 408 = provedor rejeitou (`not_sent`); DNS/recusa/rede inalcançável antes de conectar = `not_sent`; TUDO o mais (timeout/"Socket timeout", ECONNRESET, EPIPE, ETIMEDOUT, 408, 5xx, erro sem forma) = `ambiguous`. O envio ganhou `timeout: 15 s` para a resposta perdida não pendurar o ciclo.
- **Vários aparelhos:** `PushSendResult.ambiguous` (subconjunto de `failed`). Algum aparelho aceitou => `sent` (falha parcial não gera reenvio). Nenhum aceitou e algum ambíguo => `unknown`. Só falhas definitivas => `failed` (libera). Exceção que escapa do envio no worker => `unknown`; exceção ao ler assinaturas (antes de enviar) => `failed`.
- **`unknown`:** a linha vira `skipped` com `reason=unconfirmed_send`, `cause=provider_result_unknown`, e NÃO é reenviada. O estágio seguinte da escada segue normalmente.
- **Observabilidade:** um `WARN` por reserva convertida (envio ou varredura de reservas antigas) com id do livro, exceção e estágio, em texto de resultado DESCONHECIDO (não afirma entrega nem falha). `summary.unconfirmed` entra na linha de log do worker, e `GET exception-triage` devolve `unconfirmedAlerts24h` (painel mostra aviso quando > 0).
- **Custo assumido:** um timeout real perde o estágio daquele destinatário (o mesmo vale para queda do worker entre marcar e chamar o push). Preferimos perder um estágio a duplicar; o `tag` do push ainda colapsa duplicatas no aparelho.
- **Ensaio:** `apps/worker/rehearsal/exception-alerts-migration.rehearsal.test.ts` (PGlite com o esquema anterior + migração; worker real; provedor simulado pelo `sendPushToUser` real).
