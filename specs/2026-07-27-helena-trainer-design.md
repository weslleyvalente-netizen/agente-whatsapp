# Trainer da Helena (Fase 2) — Design

## Objetivo

Adicionar um "Trainer conversacional" à Central de Configuração (Fase 1,
`specs/2026-07-25-helena-config-central-design.md`): uma aba de chat em
linguagem natural onde o usuário pede mudanças de comportamento para a
Helena, o Trainer investiga a configuração atual, detecta conflitos e
duplicações, propõe uma mudança com diff explícito, e só grava no rascunho
(`agent_configs`) depois de um clique humano explícito de aprovação. Nenhuma
tabela de configuração nova é criada — o Trainer é uma segunda forma de
preencher o mesmo rascunho que o editor visual já preenche, usando o mesmo
`PATCH /agents/:id/config`.

A arquitetura de experiência é inspirada na aba "Conversar" da Assis
(mesmo SaaS de terceiros já usado como referência na Fase 1), mas com uma
diferença de segurança deliberada e central a esta spec: **a Assis escreve
no rascunho antes de mostrar diff ou pedir aprovação, para pedidos que o
modelo julga "seguros"; nós nunca fazemos isso.**

## Achados da exploração da Assis (evidência, não suposição)

Testado ao vivo na aba Conversar do agente real "Treinar Helena" (mesma
Helena, plataforma de terceiros), com reversão total ao final via
"Descartar":

- **Escrita silenciosa confirmada**: pedi "deixa o tom mais animado". A
  Trainer respondeu fazendo uma pergunta de esclarecimento ("quer ir para
  *playful* ou manter *friendly* com mais emoji?") — mas checando a aba
  Editar *antes* de eu responder, o campo Tom de voz já tinha mudado de
  "Equilibrado" para "Amigável", e o botão Publicar já mostrava contador
  "1". Confirmado via "Histórico de versões → Comparação com o rascunho
  atual: Identidade do agente alterada: Tom." — a escrita já tinha
  acontecido antes de qualquer diff ser mostrado ou aprovado.
- **Diff mostrado depois, não antes**: após eu responder, a Trainer aplicou
  mais 2 arquivos (emojis, voz) e só então mostrou um bloco de diff
  (`editou emojis +1 -1`, trecho com palavras destacadas) como *resumo do
  que já estava gravado* — não como proposta pendente de decisão.
- **Detecção de conflito real, mas não uniforme**: pedi "perguntar nome,
  cidade e modelo de uma vez" sabendo que existe uma regra de "uma
  pergunta por vez". Aqui o comportamento foi correto: identificou a regra
  existente e o arquivo que a define, explicou a contradição, ofereceu 2
  opções de resolução com recomendação, e **não escreveu nada** até minha
  confirmação (contador de Publicar ficou parado). Quando respondi "deixa
  como está", ela confirmou e não tocou em nada.
- **Conclusão**: o gate de aprovação da Assis depende do próprio modelo
  "achar" que o pedido é arriscado — não é uma garantia estrutural. É
  exatamente esse ponto que esta spec fecha: o gate é sempre o mesmo,
  código determinístico, nunca uma decisão do LLM.
- **Undo**: só existe "Descartar" tudo (mesmo mecanismo do editor visual
  hoje), com confirmação "N alterações serão perdidas, não pode ser
  desfeita". Não existe undo por sugestão individual.
- **Layout**: aba Conversar é **2 colunas** (chat à esquerda, sem árvore de
  arquivos; Playground fixo à direita) — diferente da aba Editar, que é 3
  colunas.
- **4 ações rápidas** confirmadas na tela vazia: "Analisar conversas
  reais", "Caçar inconsistências", "Ajustar o tom", "Regras de
  negociação", cada uma com um exemplo de prompt pré-preenchido.

## Escopo desta fase (Fase 2)

Entregar: aba Trainer com chat, geração de propostas com detecção de
conflito, aprovação explícita por proposta, aplicação via o mesmo PATCH do
rascunho, contadores visuais distintos (propostas pendentes vs. alterações
já aprovadas), modal de publicar com detalhe por item, e as 4 ações
rápidas. Fora de escopo: qualquer nova tool de execução real (o Trainer
nunca aciona `create_task`/`send_catalog_photo`/etc.), multi-agente,
anexar arquivos/PDF ao Trainer (a Assis tem; decisão explícita de deixar
para uma fase futura), voz/áudio no chat do Trainer.

## Princípio de segurança obrigatório

O Trainer nunca:

1. Escreve em `agents` (só `publish_agent_config` escreve, inalterado
   desde a Fase 1 — reforçado pelo teste estático
   `apps/api/src/agents-published-fields.test.ts`, que continua valendo
   sem nenhuma exceção para o Trainer).
2. Chama `publish_agent_config` ou qualquer rota `/config/publish` — só o
   clique humano em "Publicar" faz isso, exatamente como hoje.
3. Chama `PATCH /agents/:id/config` a partir do próprio LLM ou de qualquer
   código server-side automático — só a partir de um clique humano em
   "Aplicar" numa proposta específica, já renderizada na tela.
4. Recebe qualquer *tool*/function-calling capaz de escrita. A chamada de
   geração de proposta (`proposeConfigChange`, ver abaixo) usa
   só `generateObject` (mesma técnica de
   `import-suggestion.service.ts`) — não existe `tools: {...}` na chamada,
   então não há como o modelo "decidir" escrever nada por conta própria,
   independentemente do que o texto gerado diga.
5. Propõe uma regra nova sem antes conferir se algo semelhante já existe
   no rascunho atual (ver "Detecção de conflitos e duplicações").
6. Inventa política comercial (preço, desconto, condição de pagamento) que
   não veio explicitamente do usuário na conversa — se o pedido for vago
   ("dá um desconto bom"), o Trainer pergunta o valor/regra exata antes de
   propor qualquer `preco_desconto`/objeção.

## Modelo de dados

Duas tabelas novas — histórico de conversa e auditoria do Trainer. Não
duplicam `agent_configs`; guardam só a conversa e o que foi decidido sobre
ela, no mesmo espírito de `agent_playground_sessions`/`_messages` (Fase 1).

```sql
-- 00017_agent_trainer.sql
CREATE TABLE agent_trainer_sessions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_trainer_messages (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  session_id uuid NOT NULL REFERENCES agent_trainer_sessions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_trainer_messages_session ON agent_trainer_messages(session_id, created_at);
```

`proposals` guarda um array de `TrainerProposal` (ver formato abaixo),
inclusive o `status` de cada uma — assim a auditoria completa (o que foi
pedido, o que foi proposto, o que foi decidido, quando) vive na própria
mensagem que gerou a proposta, sem tabela extra. Quando uma proposta é
aplicada ou rejeitada, o backend faz um `UPDATE` pontual só no elemento
correspondente do array `proposals` daquela mensagem (por `proposal.id`),
nunca cria uma mensagem nova para registrar a decisão.

RLS: mesmo padrão de `00008_rls_policies.sql`/`get_user_org_ids()`, igual
às tabelas de playground.

## Formato estruturado de proposta

Definido em `packages/shared/src/types/agent-trainer.ts` (tipos) e
`packages/shared/src/schemas/agent-trainer.ts` (zod, para validar a saída
do `generateObject` e o body dos endpoints de aplicar/rejeitar).

Pré-requisito pequeno: hoje a árvore de seções/itens
(`SECTIONS`/`TreeNode[]` em `editar/page.tsx`, Fase 1) só existe no
frontend, como dado local da página — não há um `SectionKey` compartilhado.
Como o backend do Trainer também precisa validar contra a mesma lista
(um LLM pode alucinar uma seção que não existe), esta spec move essa
lista para `packages/shared/src/agent-config-sections.ts`:

```ts
export type SectionKey = "geral" | "personalidade" | "regras" | "conhecimento" | "playbooks" | "ferramentas";

// chave de item -> rótulo em pt-BR; null para as seções sem subitem (Geral/Playbooks/Ferramentas)
export const SECTION_ITEMS: Record<SectionKey, Record<string, string> | null> = {
  geral: null,
  personalidade: {
    tom_de_voz: "Tom de voz", emojis: "Emojis", perguntas_por_vez: "Perguntas por vez",
    postura_comercial: "Postura comercial", girias: "Gírias proibidas", proatividade: "Proatividade",
  },
  regras: {
    transferencia: "Transferência para humano", promessas: "Promessas proibidas",
    regras_por_tipo: "Regras por tipo de atendimento", preco_desconto: "Preço e desconto", objecoes: "Objeções",
  },
  conhecimento: {
    documentos: "Base de Conhecimento", faq: "FAQ", precos: "Preços", links: "Links",
  },
  playbooks: null,
  ferramentas: null,
};
export const SECTION_LABELS: Record<SectionKey, string> = {
  geral: "Geral", personalidade: "Personalidade", regras: "Regras",
  conhecimento: "Conhecimento", playbooks: "Playbooks", ferramentas: "Ferramentas",
};
```

`editar/page.tsx` passa a importar essas constantes para montar sua árvore
de navegação (hoje as chaves e os rótulos são definidos ali mesmo, e
`SECTION_LABELS` do `publish-dialog.tsx` duplica os nomes de seção) em vez
de manter cópias separadas — mudança puramente de localização, sem alterar
nenhum rótulo, ordem ou comportamento visual da Fase 1. `SECTION_ITEMS`
serve dois papéis: (a) validar `section`/`item` de uma `TrainerProposal`
contra uma lista fechada (rejeitar se o LLM alucinar uma chave que não
existe) e (b) alimentar os rótulos usados tanto pela árvore de navegação
quanto por `computeChangedSectionDetails`/`PublishDialog` — uma fonte
única, sem risco de rótulos divergentes entre os dois lugares.

```ts
export type TrainerProposalStatus = "proposed" | "approved" | "rejected" | "applied";

export interface TrainerConflict {
  description: string;          // "Personalidade > Perguntas por vez está em 1, isso pede 3 juntas"
  section: SectionKey;          // mesmas chaves da árvore da Fase 1: "personalidade" | "regras" | ...
  item: string | null;          // mesma chave de item da árvore: "perguntas_por_vez", "objecoes", ...
  resolution_options: string[]; // frases curtas, não código
}

export interface TrainerProposalDiffEntry {
  field_path: string;  // "personality.emojis.maximo", só para exibição
  before: unknown;
  after: unknown;
}

export interface TrainerProposal {
  id: string;
  section: SectionKey;
  item: string | null;          // null só para Geral/Playbooks/Ferramentas (seção = item)
  summary: string;              // "Aumentar limite de emojis de 2 para 3 por mensagem"
  rationale: string;
  conflicts: TrainerConflict[];
  diff: TrainerProposalDiffEntry[];
  patch: z.infer<typeof updateAgentConfigSchema>; // seção COMPLETA já mesclada, pronta para o PATCH existente
  status: TrainerProposalStatus;
}
```

`updateAgentConfigSchema` é o schema já existente em
`packages/shared/src/schemas/agent-config.ts` (mesmo usado pela rota
`PATCH /agents/:id/config` desde a Fase 1) — o tipo do `patch` de uma
proposta é literalmente o mesmo tipo aceito por essa rota, não um tipo
novo. `apps/web`'s `use-agent-config.ts` já tem um alias local
(`ConfigPatch`) para esse mesmo shape; o Trainer usa o schema
diretamente do pacote compartilhado, já que roda no backend.

`section`/`item` reaproveitam literalmente as mesmas chaves da árvore de
navegação construída na Fase 1
(`apps/web/src/components/agents/config/config-tree-nav.tsx` +
`editar/page.tsx`) — o Trainer nunca inventa um vocabulário próprio de
"onde" uma mudança se aplica.

`patch` é sempre o objeto de seção **completo** (ex. `personality`
inteiro, não só `emojis`), porque `updateAgentConfigSchema` já exige
seções completas desde a Fase 1 (`af97b4c`) — a montagem desse objeto
completo (mesclar a mudança pedida em cima de uma cópia do rascunho atual)
acontece no servidor, dentro do serviço de geração, nunca no cliente.

## Geração de propostas (sem escrita, sem tools)

Novo serviço, `apps/api/src/services/trainer.service.ts`, mesmo padrão de
`import-suggestion.service.ts` (mesmo `createModel`/`resolveApiKey` de
`@aula-agente/agent-runtime`, mesma técnica `generateObject` com schema
zod, **zero** `tools`):

```ts
export async function proposeConfigChange(
  db: SupabaseClient,
  agentId: string,
  sessionId: string,
  userMessage: string
): Promise<{ content: string; proposals: TrainerProposal[] }>
```

Entrada do prompt: o rascunho atual completo (`agent_configs`, todas as
seções — não só a que parece relevante, porque detecção de conflito
precisa enxergar tudo), o histórico da sessão (`agent_trainer_messages`
anteriores), e a mensagem nova. Instrução fixa no prompt (não editável
pelo usuário, mesmo espírito do `COMMON_PREAMBLE` do import-suggestion):

> Antes de propor qualquer mudança, verifique se ela contradiz ou duplica
> algo que já existe no rascunho atual. Se contradiz: não gere uma
> proposta em `patch` — preencha só `conflicts` com a explicação e as
> opções de resolução, e faça a pergunta ao usuário em `content`. Se
> duplica algo já existente (uma regra, objeção ou item de conhecimento
> semelhante): aponte a duplicata em vez de propor um item novo. Nunca
> invente valor de preço, desconto ou condição comercial que o usuário não
> disse explicitamente — pergunte antes.

A resposta é sempre `{ content: string, proposals: TrainerProposal[] }`
(schema zod dedicado) — `proposals` pode vir vazio (quando é só uma
pergunta de esclarecimento ou uma resposta informativa, ex. "Caçar
inconsistências" às vezes só relata, sem propor mudança nenhuma).

Este serviço só lê e retorna JSON. Não há nenhum `await patchAgentConfig`
nem `await db.from(...).update` em nenhum caminho deste arquivo — o teste
estático descrito em "Estratégia de testes" garante isso permanentemente.

O rascunho é lido por `getAgentConfigIfExists` (SELECT puro), não por
`getOrCreateAgentConfig` — este último faz INSERT quando o agente ainda não
tem rascunho, o que seria uma escrita. Quando não existe linha, o serviço
monta um rascunho padrão **em memória** (`buildDefaultAgentConfigDraft`,
com exatamente os mesmos valores que a linha teria) e nunca persiste nada.

## Detecção de conflitos e duplicações

Não é um passo separado de código determinístico — é uma instrução de
prompt reforçada por **dar ao modelo o rascunho inteiro, não um recorte**.
Casos cobertos pelo teste de conflito (ver "Estratégia de testes"):

- Contradição direta entre o pedido e um campo existente (exemplo do
  usuário: `perguntas_por_vez.maximo = 1` vs. pedido de 3 perguntas
  juntas) — replicado deliberadamente a partir do teste real na Assis.
- Duplicação de item de lista (ex. pedir uma objeção "cliente acha caro"
  quando já existe uma objeção "Preço alto" com conteúdo semelhante em
  `rules.objecoes`) — o prompt inclui a lista completa de `label`/`nome`
  de cada array (`transferencia_para_humano`, `promessas_proibidas`,
  `regras_por_tipo`, `objecoes`, `links`) para que o modelo compare antes
  de propor um item novo.

Quando `conflicts` não está vazio numa proposta, essa proposta **nasce sem
`patch` executável** (ou com `patch` nulo) — a UI não mostra o botão
"Aplicar" até o usuário responder à pergunta de resolução e uma nova
proposta (sem conflito) ser gerada na resposta seguinte.

## Contadores: "Propostas pendentes" vs. "Publicar N" (ajuste do usuário)

Dois estados visuais distintos, nunca confundidos:

- **Propostas pendentes**: contagem de `TrainerProposal` com
  `status = "proposed"` em toda a sessão ativa do Trainer — aparece como
  um badge na própria aba "Trainer" (ex. `Trainer ⬤2`), visível mesmo se
  o usuário estiver em Editar/Playground/Histórico. Sobe quando o serviço
  gera uma proposta nova; desce quando o usuário aplica ou rejeita.
- **Publicar N**: o badge/botão que **já existe** desde a Fase 1
  (`DraftStatusBar`, alimentado por `status.changedSections`/
  `hasPendingChanges` de `useAgentConfig`). Não ganha nenhum mecanismo
  novo — só sobe no exato momento em que `PATCH /agents/:id/config` é
  chamado, o que só acontece quando o usuário clica "Aplicar" numa
  proposta específica (ou edita manualmente na aba Editar, como já
  acontece hoje). Nunca sobe por causa de uma proposta ainda não decidida.

Isso é reforçado por um teste (ver "Estratégia de testes"): gerar uma
proposta com conflito ou sem aprovação e afirmar que nenhuma chamada a
`patchAgentConfig`/`PATCH` aconteceu.

**Múltiplas propostas/aplicações acumuladas antes de publicar**: suportado
por construção, sem mecanismo extra — o usuário pode continuar
conversando, aplicar 5 propostas em turnos diferentes, cada uma soma no
mesmo rascunho (`agent_configs`) e portanto no mesmo `changedSections`,
exatamente como hoje um usuário pode editar Personalidade e depois Regras
manualmente antes de publicar uma vez só.

## Diff por item no modal de Publicar (ajuste do usuário)

`PublishDialog` (Fase 1) hoje mostra só nomes de seção
(`"Seções alteradas: Personalidade, Regras"`). Passa a mostrar também o
item, quando aplicável, usando uma nova função pura em
`packages/shared/src/agent-config-diff.ts`:

```ts
export interface ChangedSectionDetail {
  section: SectionKey;
  label: string;
  items: { key: string; label: string }[]; // vazio para Geral/Playbooks/Ferramentas
}

export function computeChangedSectionDetails(
  current: AgentConfigSections,
  base: AgentConfigSections | null
): ChangedSectionDetail[]
```

Reaproveita a mesma comparação de `computeChangedSections` (já testada),
só adicionando um segundo nível de comparação campo-a-campo dentro de
`personality`, `rules` e `knowledge`, usando as mesmas chaves de item da
árvore da Fase 1. `computeChangedSections` em si **não muda** — continua
alimentando o `hasPendingChanges`/badge do topo exatamente como hoje;
`computeChangedSectionDetails` é usada só pelo `PublishDialog`, que passa
a renderizar algo como:

```
Personalidade
  · Emojis
  · Proatividade
Regras
  · Objeções
```

em vez da lista plana de nomes de seção. Funciona igual não importa se a
mudança veio do Trainer, de uma proposta aplicada, ou de edição manual —
o diff é sempre contra o rascunho real, não contra o log do Trainer.

## Camada de API

Mesmo padrão de autenticação/organização de todas as rotas de
`agent-config` (import direto, sem duplicar a checagem de membership em
código novo — extrair o padrão existente para um helper seria bem-vindo,
mas fica como decisão de implementação, não desta spec):

- `POST /agents/:id/trainer/sessions` — cria uma sessão (mesmo padrão de
  `POST /agents/:id/playground/sessions`).
- `GET /agents/:id/trainer/sessions/:sessionId/messages` — histórico.
- `POST /agents/:id/trainer/sessions/:sessionId/messages` — body
  `{ content: string }`; chama `proposeConfigChange`, grava a mensagem do
  usuário e a resposta do assistente (com `proposals`) em
  `agent_trainer_messages`, devolve a mensagem do assistente. **Não
  aceita nem executa nenhum patch.**
- `POST /agents/:id/trainer/proposals/:proposalId/apply` — busca a
  proposta (localizada pelo `id` dentro do jsonb `proposals` da mensagem
  que a contém), valida que `status === "proposed"` e que `conflicts`
  está vazio, chama o **mesmo** `patchAgentConfig` já usado pelo editor
  visual com o `patch` gravado na proposta, atualiza `status` para
  `"applied"` na mensagem.
- `POST /agents/:id/trainer/proposals/:proposalId/reject` — só atualiza
  `status` para `"rejected"`. Nunca toca em `agent_configs`.

Nenhuma rota nova de publish — `POST /agents/:id/config/publish` (Fase 1)
continua sendo a única forma de publicar, inalterada.

## Ações rápidas

Mesmos 4 conceitos observados na Assis, com prompts adaptados ao nosso
domínio (não é texto proprietário — são padrões genéricos de UX de
"comece por aqui"):

- **Analisar conversas reais** — "Veja as últimas conversas e sugira
  melhorias na configuração."
- **Caçar inconsistências** — "Procure regras conflitantes ou duplicadas
  na configuração atual."
- **Ajustar o tom** — "Deixe o tom mais animado."
- **Regras de negociação** — "Nunca dê desconto sem confirmar antes."

Cada card só preenche o campo de mensagem (mesmo comportamento observado
na Assis) — não pula a etapa de proposta/diff/aprovação.

## Privacidade — "Analisar conversas reais"

A consulta que alimenta este fluxo (`apps/api/src/services/trainer.service.ts`,
função separada, ex. `buildConversationPatternContext`) segue,
obrigatoriamente:

- Nunca seleciona `wa_contacts.name`/`wa_contacts.phone` nem qualquer
  coluna de `conversation_notes`/`task` — só `messages.role`,
  `messages.content` e `messages.created_at`, de uma janela limitada
  (ex. últimas 50 conversas ou últimos 14 dias, o que vier primeiro).
- Antes de montar o prompt, roda um passo de redação simples (regex) para
  mascarar padrões de telefone/CPF/e-mail que apareçam dentro do
  `content` das mensagens (clientes às vezes digitam o próprio número no
  texto).
- Prefere, quando possível, resumir estatisticamente no servidor antes de
  mandar ao modelo (ex. "customer repetiu o nome em 4 de 12 conversas
  porque foi perguntado duas vezes") em vez de mandar transcrição crua —
  decisão de implementação, mas o contrato desta spec é que o prompt final
  nunca contém PII identificável.
- `agent_trainer_messages` nunca guarda o conteúdo bruto das conversas
  analisadas — só a proposta/resposta gerada a partir delas.

## Frontend

Nova aba na mesma barra de tabs da Fase 1
(`apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`):
`Editar | Playground | Histórico | Trainer`. Layout de **2 colunas**
dentro dessa aba (sem a árvore de navegação — igual ao observado na
Assis): chat do Trainer à esquerda/centro, `PlaygroundPanel` (Fase 1,
sem nenhuma mudança) fixo à direita, mesmo mecanismo de scroll
independente já corrigido na Fase 1.

Wireframe textual:

```
┌──────────────────────────────────────────┬────────────────────────┐
│ Treine a Helena conversando               │ Playground      [↻]   │
│ [Analisar conversas] [Caçar inconsist.]   │ (fixo, scroll próprio) │
│ [Ajustar o tom]      [Regras negociação]  │                        │
│────────────────────────────────────────── │                        │
│ (thread, scroll próprio)                  │                        │
│  usuário: "..."                           │                        │
│  trainer: texto explicativo               │                        │
│    ┌─ Personalidade › Emojis ───────────┐ │                        │
│    │ de 2 → 3 emojis por mensagem       │ │                        │
│    │ [Aplicar]  [Rejeitar]              │ │                        │
│    └─────────────────────────────────────┘│                        │
│────────────────────────────────────────── │                        │
│ [Digite uma mudança...]            [➤]   │                        │
└──────────────────────────────────────────┴────────────────────────┘
```

Componentes novos, todos em `apps/web/src/components/agents/config/`:

- `trainer-panel.tsx` — orquestra sessão, lista de mensagens, input (mesmo
  padrão de estado local de `playground-panel.tsx`, sem reaproveitar o
  componente em si porque o conteúdo de cada mensagem é mais rico —
  precisa renderizar cards de proposta, não só texto).
- `trainer-proposal-card.tsx` — um card por `TrainerProposal`: resumo,
  diff (`before`/`after` lado a lado), lista de `conflicts` quando não
  vazia (sem botão Aplicar nesse caso), botões Aplicar/Rejeitar quando
  aplicável, e o `status` final depois de decidido (badge "Aplicada" /
  "Rejeitada", sem os botões).
- `use-trainer-session.ts` — hook análogo a `use-playground-session.ts`.

`PublishDialog` (Fase 1) ganha o detalhamento por item descrito acima —
único componente existente que muda de fato.

## Segurança / não quebrar produção

- `agents`, `agent_versions`, `publish_agent_config`: nenhuma mudança.
- `patchAgentConfig`, `updateAgentConfigSchema`, `agent_configs`: nenhuma
  mudança de schema ou de contrato — o Trainer só é mais um chamador do
  mesmo endpoint `PATCH /agents/:id/config`.
- `agents-published-fields.test.ts` (Fase 1) continua rodando sem
  exceção — se o Trainer algum dia importar algo que escreva em `agents`
  fora de `publish_agent_config`, o teste estático já existente falha.
- Playground, Prompt Builder, Publicar/Descartar: zero mudança funcional,
  só o `PublishDialog` ganha mais detalhe de exibição (aditivo).
- Rotas novas seguem o mesmo middleware de autenticação/organização já
  usado por toda `apps/api` — nenhum caminho novo de acesso sem checagem
  de `membership`.

## Estratégia de testes

- **Teste estático** (mesmo padrão de `agents-published-fields.test.ts`):
  varrer `apps/api/src/services/trainer.service.ts` e os handlers de rota
  novos e falhar se houver qualquer chamada a `patchAgentConfig`,
  `publishAgentConfig`/`publish_agent_config`, ou `.from("agents")` fora
  do endpoint de `/apply` — ou seja, provar que só existe **um** caminho
  de escrita, e que ele só é alcançável pelo endpoint de aprovação
  explícita.
- **Testes de `proposeConfigChange`** (LLM mockado, mesmo padrão de
  `import-suggestion.service.test.ts`):
  - cenário de conflito (perguntas_por_vez=1 + pedido de 3 juntas): a
    resposta mockada tem `conflicts` preenchido e `patch` vazio/nulo;
    afirma que nenhuma proposta com `patch` executável foi retornada.
  - cenário de duplicação (pedir objeção semelhante a uma já existente):
    o prompt enviado ao modelo mockado deve conter a lista atual de
    `objecoes` (assert no corpo da chamada), garantindo que o contexto
    de duplicação realmente chega ao modelo.
  - cenário simples sem conflito: `patch` retornado é a seção completa
    (não um fragmento), validado contra `updateAgentConfigSchema`.
- **Teste do endpoint de aplicar**: usa exatamente `patchAgentConfig`,
  reaproveitando os mesmos fixtures/mocks de
  `agent-config.service.test.ts`; confirma que `status` da proposta muda
  para `"applied"` só depois do PATCH ter sucesso.
- **Teste do endpoint de rejeitar**: confirma zero chamadas a qualquer
  função de escrita em `agent_configs`.
- **Teste de contador**: gerar 2 propostas, aplicar 1, afirmar
  `changedSections`/`hasPendingChanges` refletem só a aplicada — a outra,
  ainda "proposed", não aparece no diff do rascunho.
- **Teste de privacidade**: para `buildConversationPatternContext`,
  montar um fixture de mensagens com um número de telefone dentro do
  `content` e afirmar que o prompt final não contém esse padrão nem
  nome/telefone de `wa_contacts`.
- **Manual/E2E** (checklist de aceite, mesmo espírito do checklist final
  da Fase 1): pedir mudança sem conflito → ver proposta com diff → clicar
  Aplicar → conferir `agent_configs` mudou e "Publicar 1" apareceu →
  pedir mudança conflitante → conferir que nenhuma proposta aplicável foi
  gerada e "Publicar" não mudou → testar no Playground → publicar →
  conferir modal lista seção **e item** corretamente → conferir `agents`
  só muda depois desse clique final.

## Fases e não-escopo

Fora de escopo desta Fase 2, por decisão explícita: anexar arquivo/PDF ao
Trainer, edição do `patch` de uma proposta antes de aplicar (diferente da
Fase 1, onde a sugestão de importação é editável campo a campo — aqui a
proposta é aplicada como veio ou rejeitada, para manter o fluxo simples;
pode virar uma Fase 3 se necessário), notificações/lembretes de propostas
pendentes fora da própria tela, e qualquer tool de execução real
controlada pelo Trainer.
