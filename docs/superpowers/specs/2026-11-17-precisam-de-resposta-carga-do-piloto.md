# "Precisam de resposta" — chamadas da tela e carga estimada do piloto (validação isolada, flag desligada)

Local, sem commit. Nenhuma consulta em produção, índice, merge, deploy ou migração. SHA medido: `d103918`.

## Como foi medido
- Aplicação web **de produção** (`next build` + `next start`, localhost) falando com um **servidor simulado** (Supabase + API) que registra cada requisição por fase. Sessão de teste local.
- Fases: (1) abrir a tela (carga completa), (2) ir ao funil de vendas, (3) voltar para o início, (4) focar a aba 3x (eventos `blur`/`focus`/`visibilitychange`), (5) deixar a tela aberta 150 s. Quatro cenários: vendedor e gestor × flag ligada e desligada.
- Nota: em modo de desenvolvimento a volta mostrava 2 chamadas de cada (StrictMode do React); em produção é 1. Os números abaixo são de produção.
- Chamadas ao banco por requisição: handlers reais da API com o módulo de banco instrumentado.

## Chamadas HTTP da tela inicial (iguais nos 4 cenários)
| Evento | `/dashboard/summary` | `/dashboard/today` | `/dashboard/needs-reply` (fila) |
|---|---|---|---|
| Abrir a tela | 1 | 1 | 1 |
| Voltar de uma conversa | 1 | 1 | 1 |
| Focar a aba (3x) | 0 | 0 | 0 |
| Deixar aberta 150 s | 0 | 0 | 0 |

- **A fila é chamada mesmo com a flag desligada** (a rota devolve `{enabled:false}`, mas a chamada e a leitura da organização acontecem).
- Não há polling nem ouvinte de foco/visibilidade na tela inicial; o provider da organização fica no layout e não refaz a busca ao navegar.
- Gestor: além disso, o aviso de saúde (`/health`) chama 1x ao abrir e a cada 60 s (3 em 150 s); já existe hoje.
- Frescor: a fila só se atualiza ao montar a tela. Depois de responder na conversa e voltar, ela recarrega (1 chamada) e o caso sai. Com a tela parada numa aba, não atualiza sozinha.

## Idas ao banco por requisição
| Rota | Vendedor | Gestor | Detalhe |
|---|---|---|---|
| `/dashboard/summary` | 126 (takeover=121) / 1.336 (takeover=1.331) | igual | 5 consultas + **1 por conversa em takeover (N+1)** |
| `/dashboard/today` | 4 | 3 | tarefas, organização, handoffs, (vendedores) |
| `/dashboard/needs-reply` (fila) | 2 | 3 | organização + RPC (+ vendedores, só gestor) |

## Custo por chamada da fila (medido antes no PostgreSQL 17, sintético)
| | 3 mil conv. / 125 mil msgs | 30 mil conv. / 1,29 mi msgs |
|---|---|---|
| Gestor: linhas de `messages` lidas (tempo) | 34.329 (12 ms) | 398.802 (136 ms) |
| Vendedor: idem | ~15.400 (8 ms) | ~171.000 (52 ms) |

Resumo, no mesmo volume menor: ~1.121 linhas de `messages` (1.000 do limite padrão do PostgREST + 121 do N+1), 3 varreduras de `conversations`, 126 idas ao banco.

## Estimativa de carga adicional do piloto (premissas minhas; não há telemetria de uso)
Premissas: 4 usuários no piloto (2 vendedores + 2 gestores); cada "montagem" da tela = 1 chamada da fila; baixo/normal/alto = 10/30/80 montagens por usuário por dia útil.

| Cenário | Chamadas da fila/dia | Linhas de `messages`/dia (vol. menor) | Linhas/dia (stress) | Tempo de banco/dia |
|---|---|---|---|---|
| Baixo | 40 | ~1,0 mi | ~11 mi | 0,4 s – 3,6 s |
| Normal | 120 | ~3,0 mi | ~34 mi | 1,2 s – 11 s |
| Alto | 320 | ~8,0 mi | ~91 mi | 3,2 s – 30 s |

Comparação: o resumo já faz o mesmo nº de montagens com ~126 idas ao banco cada (normal: ~15 mil idas/dia, ~134 mil linhas de mensagens/dia). A fila faz **2–3 idas**, mas lê **15–30x mais linhas de `messages`** por chamada.
Leituras por índice, quase todas em cache quando a tabela cabe na memória; no stress, a primeira chamada fria tocou ~98 mil blocos (17,5 mil lidos do disco, ≈140 MB) e depois tende a zero de leitura em disco. O tamanho real de `messages` em produção **não foi medido**.

## Quem teria acesso com a flag por organização (confirmado no código)
- Flag: `organizations.settings.needs_reply_queue_enabled === true` — **por organização**, não por usuário.
- Rota: qualquer **membro** da organização (`owner`, `admin`, `agent`) recebe `enabled:true`; a tela inicial troca "Tarefas urgentes" pela fila para **todos** os membros.
- Visibilidade: `owner`/`admin` veem todos os vendedores + sem dono; `agent` vê só o que é dele (`p_owner`). Se `lead_distribution_enabled` e `seller_isolation_enabled` estiverem ambos desligados, **todo mundo** vê tudo (modo "all"); não verifiquei em produção.
- **Não dá para limitar o piloto à Marina e ao Márcio hoje**: não há lista de usuários nem papel específico. Qualquer outro membro `agent` que não seja vendedor também perderia "Tarefas urgentes" (veria a fila, em geral vazia).

## Recomendação
Não pilotar exatamente como está. Antes, duas mudanças pequenas (sem tocar na regra, na janela de 30 dias nem no frescor):
1. **Lista de usuários do piloto** (ex.: `needs_reply_queue_user_ids` nas configurações): a rota devolve `{enabled:false}` para quem não está na lista, e a tela mantém "Tarefas urgentes" para eles. Limita carga e visibilidade à Marina, ao Márcio (e, se quiser, a gestores).
2. **Não chamar a fila quando a flag da organização está desligada**: a tela já tem `currentOrg.settings`; hoje cada montagem de qualquer usuário gasta 1 chamada + 1 leitura de organização à toa.

Não cortar a recarga ao voltar da conversa (é o que faz o caso sair da fila depois da resposta humana). Opcional depois do piloto: recarga limitada ao voltar o foco da aba (no máximo 1 por minuto), só se o piloto mostrar fila velha em aba parada. O índice em `messages` e a leitura de tamanho em produção ficam como decisão separada (a leitura de tamanho é um `pg_class`, sem varrer a tabela, mas exige autorização).
