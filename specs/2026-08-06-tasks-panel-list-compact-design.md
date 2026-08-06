# Tasks Panel & List — Compact Rendering Design

## Contexto

O redesign anterior (`2026-08-05-tasks-inbox-ux-design.md`, já implementado e em
produção) trocou os cards da lista de Tarefas por linhas mais enxutas e
reorganizou o painel lateral em accordions. Depois de usar em produção, dois
problemas ficaram claros:

1. **Painel:** o modo de visualização continua mostrando todo campo possível,
   inclusive os vazios, como `"Não informado"`. Isso deixa o painel comprido e
   com aparência de formulário em branco, mesmo quando o cliente informou
   pouca coisa.
2. **Lista:** cada linha ainda é visualmente um card isolado — borda própria,
   cantos arredondados, `space-y-2` entre elas — em vez de uma lista compacta
   estilo caixa de entrada (Gmail/HubSpot/Pipedrive), que foi o objetivo
   original do redesign anterior.

Esta spec cobre as duas correções. **Nenhuma delas toca banco, API, regra de
negócio ou o comportamento da Helena** — é exclusivamente lógica de
renderização e UX no `apps/web`.

## Parte 1 — Painel: exibir somente campos preenchidos

### Princípio

No modo de visualização, cada seção do painel mostra **somente os campos que
têm valor**. Campo `null`/vazio não aparece — nem como linha com
`"Não informado"`, nem de nenhuma outra forma. Seção sem nenhum campo
preenchido não aparece.

O modo de edição continua mostrando **todos** os campos possíveis daquela
seção, inclusive os vazios, para o vendedor preencher. Salvar volta para o
modo de visualização mostrando só o que ficou preenchido.

### Levantamento dos campos existentes

Todo o modelo de qualificação vem de uma única tabela
(`supabase/migrations/00020_conversation_qualifications.sql`). Não há colunas
para: lance "próprio" vs. "embutido" separados (existe só `bid_amount`),
"valor a financiar" como campo salvo (é derivado), "orçamento"/"forma de
pagamento" (compra à vista), ou "veículo"/"problema relatado" estruturados
(oficina/peças). Esses conceitos **não serão implementados** nesta spec —
ficariam para uma tarefa futura de schema, fora de escopo aqui.

Campos existentes por seção:

| Seção | Campos | Coluna |
|---|---|---|
| Resumo | Resumo | `summary` |
| Informações comerciais | Produto, Modelo, Valor da venda, Entrada, Parcela desejada, Prazo (meses) | `product_interest`, `product_model`, `sale_amount`, `down_payment_amount`, `target_installment_amount`, `term_months` |
| Financiamento (só `attendance_type = financing`) | CPF, Nascimento, Possui CNH, Categoria CNH | `cpf`, `birth_date`, `has_driver_license`, `driver_license_category` |
| Consórcio (só `attendance_type = consortium`) | Crédito desejado, Lance | `credit_amount`, `bid_amount` |
| Dados do cliente | Tipo de atendimento, Cidade, Finalidade de uso, Urgência | `attendance_type`, `city`, `usage_purpose`, `urgency` |
| Observações | Observações | `commercial_notes` |
| Próxima ação (bloco próprio, fora do accordion) | Próxima ação | `next_action` |

`Entrada` continua excluída de "Informações comerciais" quando
`attendance_type = consortium` (comportamento já existente, preservado).

### Regras por seção

- **Resumo do atendimento** — deixa de ser um `AccordionItem`. Vira um bloco
  simples, sempre visível, sem toggle de abrir/fechar. Se `summary` existir,
  mostra o texto (truncado em 3 linhas com "Mostrar mais", como já é hoje).
  Se `summary` for `null`, mostra a frase fixa
  `"Nenhum resumo disponível ainda."` em itálico/muted, no lugar do texto —
  **nunca esconde a seção inteira**, é a única exceção à regra
  "seção vazia some".
- **Informações comerciais** — accordion, só renderiza se ao menos um dos
  campos genéricos tiver valor. Grade de destaque (2 colunas) mostra só os
  campos com `emphasize: true` que tiverem valor; campos sem valor não geram
  bloco vazio na grade. Aberta por padrão quando aparece.
- **Financiamento** — accordion, só renderiza se `attendance_type = financing`
  **e** ao menos um dos 4 campos tiver valor. Fechada por padrão. Dentro
  dela, além dos campos preenchidos, mostra o bloco calculado **"Valor a
  financiar"** (ver abaixo) quando aplicável.
- **Consórcio** — accordion, só renderiza se `attendance_type = consortium`
  **e** `credit_amount` ou `bid_amount` tiver valor. Fechada por padrão.
- **Dados do cliente** — accordion, só renderiza se ao menos um dos 4 campos
  tiver valor. Fechada por padrão.
- **Observações** — accordion, só renderiza se `commercial_notes` tiver
  valor. Fechada por padrão.
- **Próxima ação** — não é um `AccordionItem`. Bloco de destaque (mesmo
  estilo visual dos blocos de valor emphasized: `rounded-md border
  bg-muted/30 p-2`), renderizado fora do accordion, sempre visível quando
  `next_action` tiver valor, posicionado após o accordion (última coisa do
  painel). Continua editável — o campo `next_action` permanece no formulário
  de edição de "Informações comerciais" (sua seção de origem), só sai da
  listagem padrão do modo de leitura porque ganha exibição própria.

### "Valor a financiar" (campo calculado, não salvo)

Dentro da seção **Financiamento**, quando `attendance_type = financing` e
tanto `sale_amount` quanto `down_payment_amount` estiverem preenchidos, exibe
um bloco extra no mesmo estilo dos blocos de destaque:

```
Valor a financiar
R$ 35.000
```

Calculado como `sale_amount - down_payment_amount`, formatado com
`formatCurrencyBRL`, **somente no momento da renderização** — nada é salvo,
nenhuma coluna nova, nenhuma chamada de API. Esse valor nunca aparece no modo
de edição (não existe coluna para editar).

### Helpers reutilizáveis (requisito explícito do pedido)

Em `qualification-section.tsx`, exportados para reuso:

- `hasValue(value: unknown): boolean` — `true` quando o valor não é `null`,
  `undefined` nem string vazia. Substitui a checagem que hoje só existe
  dentro de `formatReadValue`.
- `sectionHasContent(fields: QualificationFieldDescriptor[], values: Record<string, unknown>): boolean`
  — `fields.some(f => hasValue(values[f.key]))`. Usado pelo painel para
  decidir se um `AccordionItem` deve renderizar.
- `formatReadValue` (já existe) — passa a ser exportado, sem mudança de
  comportamento, para reuso onde for necessário formatar um valor fora do
  componente.

### Novo campo em `QualificationFieldDescriptor`: `hideInView`

`next_action` precisa continuar editável dentro do formulário de "Informações
comerciais" (`fields` completo, usado no modo de edição), mas sumir da
listagem de leitura padrão (porque ganha bloco próprio). Isso é resolvido com
uma flag opcional `hideInView?: boolean` no descriptor:

- Modo de leitura: os dois loops de campos (`emphasize` e não-`emphasize`)
  filtram `!f.hideInView` antes de renderizar.
- Modo de edição: **sem mudança** — continua iterando sobre `fields`
  completo, então `next_action` permanece no formulário.
- `sectionHasContent`, quando chamado pelo painel para decidir se
  "Informações comerciais" deve aparecer, recebe a lista de campos **já
  filtrada** (`fields.filter(f => !f.hideInView)`) — um `next_action`
  preenchido sozinho, sem nenhum outro campo comercial, não deve forçar a
  seção a aparecer (ele já aparece no bloco próprio de qualquer forma).

## Parte 2 — Lista de tarefas: linhas compactas estilo Inbox

### Problema

Hoje cada `TaskCard` é `rounded-md border p-3`, empilhados com `space-y-2`
entre eles — visualmente ainda são cards isolados, não uma lista compacta.

### Layout da linha (altura alvo ~64–80px)

```
Nome do cliente                    tipo   [Quente] [Prioridade] [Status]
Resumo (até 2 linhas)
Responsável · Vencimento · Tempo desde última interação
```

- O tipo da tarefa (`TASK_TYPE_LABELS[task.type]`) sobe para a mesma linha do
  nome, como texto discreto — hoje ocupa uma linha própria, é isso que infla
  a altura. Badges de "Quente" (se `isHotLead`), Prioridade e Status
  continuam como hoje, só reagrupados na mesma linha.
- Resumo (`task.description`) continua `line-clamp-2`.
- Linha de metadados (`assigneeLabel · dueLabel · formatRelativeTime`) sem
  mudança de conteúdo — vencimento e tempo desde a última interação
  continuam distintos, um não substitui o outro (regra já vigente desde a
  spec anterior).
- Nenhuma ação (Concluir/Reagendar/Editar/Cancelar/Abrir conversa) na linha —
  isso já está correto hoje, permanece assim.

### Divisores em vez de cards

- Cada linha perde `rounded-md border` e o padding vira `px-3 py-2` (sem
  borda própria, sem canto arredondado individual).
- O contêiner de cada grupo (Leads quentes / Follow-ups, e a lista simples
  das outras abas) troca `space-y-2` + cards por `divide-y` — divisor
  horizontal fino entre as linhas, sem espaço morto entre elas.
- A lista inteira (dentro de cada grupo) ganha **uma única borda/canto
  arredondado externo**, ao redor de todas as linhas juntas — não mais um
  por linha. Padrão comum de inbox (Gmail/HubSpot): uma "caixa" contendo
  várias linhas divididas por linha fina.

### Seleção e hover

- Linha selecionada: `bg-accent/40` + barra vertical primária à esquerda
  cobrindo a altura inteira da linha (`inset-y-0`, ajustado de `inset-y-1`
  porque não há mais borda arredondada individual para respeitar).
- Hover: `bg-accent/30`, sutil, sem alterações de sombra/escala.
- Destaque permanece enquanto o painel estiver aberto, some ao fechar ou ao
  selecionar outra tarefa — comportamento já existente, preservado
  integralmente (usa o mesmo `selectedTaskId` que já preserva filtro/aba/
  scroll, sem mudança nessa lógica).
- A linha inteira continua clicável (mesmo `onClick` no container).

### Responsividade

- Nome + badges (tipo/quente/prioridade/status) ficam na primeira linha, com
  `flex-wrap` para não estourar em telas estreitas — se não couber tudo,
  quebra para uma segunda linha dentro do mesmo bloco, sem cortar o nome.
- Resumo permanece `line-clamp-2` em qualquer largura.
- Linha de metadados já é texto corrido (`·` como separador dentro de um
  único `<p>`), portanto já quebra naturalmente em telas estreitas sem
  alteração de código.
- Em nenhuma largura a linha volta a ter coluna de botões — não há botões na
  lista, então esse risco não existe estruturalmente.

### Grupos preservados

"🔥 Leads quentes" e "🟡 Follow-ups" continuam com seus cabeçalhos `h3`
acima de cada grupo. Só a lista de linhas dentro de cada grupo troca de
cards com `space-y-2` para uma caixa única com `divide-y`.

Nas demais abas (Atrasadas, Próximas, Concluídas — sem agrupamento por
lead quente/follow-up), a mesma troca se aplica: a lista plana de
`TaskCard`s também vira uma única caixa com `divide-y`, em vez de cards
soltos com `space-y-2`.

## Validação (mínimo, ambas as partes)

1. Financiamento com poucos campos preenchidos.
2. Financiamento completo (todos os campos + valor a financiar calculado).
3. Consórcio sem lance.
4. Consórcio com lance.
5. Tarefa apenas com resumo (mais nada preenchido).
6. Tarefa sem qualificação nenhuma (`EMPTY_QUALIFICATION`).
7. Lista: comparação visual antes/depois mostrando altura de linha, divisores
   em vez de cards, e o destaque de seleção cobrindo a linha inteira.
8. Lista: teste de responsividade (mobile) confirmando que nome+badges
   quebram sem gerar coluna de botões e sem cortar o nome.

## Restrições (reafirmadas)

- Não alterar banco, migrations, endpoints da API ou a tool da Helena.
- Não alterar regras de negócio, `human_locked_fields`, ou qualquer lógica de
  `draftToPatch`/salvamento — só o que é renderizado em modo de leitura.
- Alteração restrita a `apps/web` (componentes `tasks/*` e, se necessário,
  `lib/utils.ts`).

## Fora de escopo (explicitamente adiado)

- Novas colunas para lance próprio/embutido, orçamento, forma de pagamento,
  veículo/problema relatado estruturados.
- O texto sintetizado `"Estratégia: só pagamento mensal, sem lance"` do
  exemplo original do pedido — não há campo que distinga "cliente recusou
  lance explicitamente" de "campo ainda não preenchido"; omitir `bid_amount`
  quando nulo é o comportamento correto disponível hoje.
