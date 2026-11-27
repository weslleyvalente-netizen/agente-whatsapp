# Plano de ativação: `commitments_enabled` (PR #120)

Preparado em 22/11/2026, depois do merge `15853d2`. **Nada foi alterado. Cada passo precisa de autorização expressa do dono.**

## 1. Prontidão (verificada em 22/11, somente leitura)

| Item | Resultado |
|---|---|
| Código em produção | `15853d2` (#120); API reiniciou 14:42, web 14:44, CI verde |
| Teste bidirecional | CRM→celular 18:10:31 (entregue 18:10:41, lido 18:10:48); celular→CRM 18:10:54; mesma conversa, 0 duplicadas, 0 falhas |
| Worker/BullMQ | Agendamento de SLA (60 s): +6 chamadas em 5 min 21 s. Consulta de organizações dos agendamentos de 5/30 min: +6 em 15 min 22 s (sem o worker de promessas seriam 3–4) → agendamento `commitments-scheduler` registrado e rodando |
| Flags do #120 | Todas ausentes (desligadas); `holiday_set` ausente; push do gestor ausente |
| Tabelas novas | 0 linhas; nenhum `sistema_sem_resposta` |
| Tipos de tarefa | `return_customer` e `proposal_followup` já existem (texto livre, sem restrição) |
| Envio ao cliente | A rotina não tem caminho de envio. Sugestão de follow-up só sai quando o vendedor clica (`POST /tasks/:id/followup-…`) |
| Logs do worker | **Não lidos**: EasyPanel bloqueado para a extensão. O worker escreve a cada 5 min `commitments: orgs=… proposals=… reminders=… promises=… resolved=… errors=…` |

## 2. Calendário da Moto e Trilha (atual)

- Seg a sex 07:30–18:00, sáb 08:00–12:00, domingo fechado, fuso America/Sao_Paulo.
- Fechados manualmente: 02/11/2026, 20/11/2026, 25/12/2026, 01/01/2027. Sem períodos fechados.
- Prazo padrão de promessa: 120 min úteis (`promise_default_minutes` ausente). Lembrete de proposta: 30 min úteis.

### Feriados `posse_go`

| Data | Feriado | Base | Situação |
|---|---|---|---|
| 01/01, 21/04, 01/05, 07/09, 12/10, 02/11, 15/11, 20/11, 25/12 | Nacionais | Lei 662/1949; 20/11 pela Lei 14.759/2023 | Confirmados |
| Sexta-feira Santa (26/03/2027) | Nacional | Móvel | Confirmado |
| 19/07 | Aniversário de Posse | Lei municipal 110/1985 (tabela do TJ-GO) | Confirmado pelo TJ-GO |
| 26/07 | Padroeira N. Sra. Sant'Ana + Fundação da Cidade de Goiás | Lei 110/1985; GO | Confirmado (TJ-GO); estadual coincide |
| 19/10 | Dia do Monsenhor | Lei municipal 1.283/2020 (TJ-GO) | Confirmado pelo TJ-GO |
| 30/05 | "Feriado municipal" | Só 1 site, sem lei | **Fora** até confirmação |

- Com `holiday_set: "posse_go"`, a primeira data nova fechada é **26/03/2027**. Até lá não muda nada (simulado).
- Decisões da loja, que não são feriado legal: 24/12, 31/12, Carnaval (08–09/02/2027), Corpus Christi (27/05/2027). Entram por `extra_holidays`.

## 3. O que `commitments_enabled` faz

- A cada 5 min lê as mensagens dos vendedores (na 1ª rodada, as últimas 24 h; histórico mais antigo é ignorado).
- **Promessa de retorno** ("vou verificar e te retorno"): grava `seller_commitments` e cria/atualiza a tarefa interna "Retornar ao cliente", prioridade alta, com o prazo da promessa. Mensagem genérica não encerra. Encerram: tarefa concluída, entrega com evidência forte ou negócio fechado.
- **Proposta enviada** (valor + termo comercial, PDF de proposta ou etapa movida): grava `proposal_followups`. Se 30 min úteis depois o cliente não respondeu e o vendedor não voltou a escrever, cria a tarefa interna "Follow-up de proposta". Só em horário de funcionamento.
- **Nada é enviado ao cliente.**
- A deduplicação por negócio pode **juntar** a pendência a uma tarefa aberta do mesmo negócio (consolidação ligada). O monitoramento mede isso (linha 11).

## 4. Linha de base (últimos 7 dias)

| Métrica | Valor |
|---|---|
| Tarefas criadas por dia | 16/11: 21, 17/11: 17, 18/11: 6, 19/11: 8, 20/11: 3, 21/11: 2, 22/11: 2 |
| Tarefas `return_customer` / `proposal_followup` criadas em 7 dias | 8 / 1 |
| Abertas agora | customer_unresponsive 17, scheduled_callback 8, stalled_negotiation 8, vehicle_followup 5, return_customer 3, demais 1 cada |
| Encerradas por dia | 16/11: 27, 17/11: 7, 18/11: 2, 19/11: 12, 21/11: 4 (+1 cancelada) |
| Abertas duplicadas (mesmo negócio + tipo) | 0 |
| Abertas consolidadas | 7 |
| Mensagens de vendedor por dia | 16/11: 211, 17/11: 136, 18/11: 44, 19/11: 189, 20/11: 1, 21/11: 103, 22/11: 2 (3 vendedores) |

## 5. Execução proposta

1. **Segunda 23/11, 08:00** (loja aberta, vendedores ativos; a 1ª rodada lê só domingo).
2. Backup de `settings` → `backup-org-settings-antes-commitments-2026-11-23.json`.
3. Pré-checagem: `6-monitorar-commitments.sql` (tudo zerado) e saúde da API.
4. Rodar `4-ativar-commitments.sql` (liga só se a chave não existir; confere que as outras 3 flags seguem ausentes).
5. Em até 10 min: primeira rodada (linha 15 ou log do worker).
6. **Fora desta ativação** (aprovado em 22/11): calendário de feriados, @lid, rodízio e cards urgentes seguem desligados. `7-ativar-holiday-set.sql` fica versionado para uma etapa futura, com autorização separada.

## 6. Monitoramento de 24 h e desligamento

- `6-monitorar-commitments.sql`, com o instante da ativação no topo:
  - a cada 5 min na primeira hora (08:00–09:00);
  - a cada 30 min até 12:00;
  - de hora em hora até 18:00;
  - fechamento na terça 24/11 às 08:00 (24 h).
- Mais a saúde da API e a amostra de 5 tarefas criadas, lidas por mim para checar falso positivo.
- **Desligar na hora** (`5-desligar-commitments.sql`, efeito em até 5 min) se:
  - linhas 6, 8 ou 9 = `DESLIGAR`;
  - linha 1 com flag não autorizada;
  - mais de 15 tarefas da rotina em 1 hora;
  - qualquer mensagem automática ao cliente;
  - falso positivo em 2 de 5 amostras;
  - pedido de qualquer vendedor.
- Desligar não apaga nada. As tarefas criadas ficam para revisão (consulta B do script 5); cancelar é decisão separada.

## 7. Revisão de 23/11 (depois do #122)

Situação em 23/11:
- Em produção: o #122, merge `d4ef479`, com a migração `20261122150000`.
- As tarefas da rotina passaram a ser **independentes**. Cada uma é marcada por `tasks.commitment_kind` e fica no máximo uma aberta por conversa e marca. Por isso a seção 3 ficou desatualizada no ponto em que diz que a pendência pode ser juntada a uma tarefa aberta do mesmo negócio: isso não acontece mais.

Mudanças no `6-monitorar-commitments.sql`:

| Linha | Mudança |
|---|---|
| 1 | Também para se o push do gestor estiver ligado ou se `holiday_set` existir. |
| 9 | Conta só as tarefas comuns criadas desde a ativação. As da rotina são independentes por regra. |
| 11 | Uma tarefa antiga usada pela rotina agora é `DESLIGAR`, porque deve ser 0. |
| 16 a 19 (novas) | Linha 16: tarefa da rotina sem marca. Linha 17: duas tarefas da rotina abertas na mesma conversa e marca. Linha 18: tarefa de outro fluxo que recebeu pendência da rotina. Linha 19: status das tarefas da rotina. |

As linhas 16, 17 e 18 levam a `DESLIGAR`.

Prévia das últimas 24 h, feita em 23/11 às 15:53 (Brasília): somente leitura, com o código do main `d4ef479` rodando sobre os dados reais e sem gravar nada.

- **Primeira rodada:**
  - 6 propostas, 1 lembrete e 1 promessa;
  - essa promessa já tinha sido entregue, então a tarefa dela nasce e é encerrada na mesma rodada, com a nota "Retorno prometido entregue ao cliente";
  - nenhuma tarefa existente é alterada e não há erros.
- **24 h em rodadas de 5 min:** 6 propostas, 1 lembrete, 2 promessas (ambas entregues), no máximo 1 tarefa por hora e 0 erros.
