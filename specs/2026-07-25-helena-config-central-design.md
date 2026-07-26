# Central de Configuração da Helena — Design

## Objetivo

Substituir o modelo atual de configuração da Helena — um único campo de texto
livre (`agents.system_prompt`) editado direto do browser — por uma central de
configuração modular (Identidade / Personalidade / Regras / Conhecimento /
Playbooks / Ferramentas), com um Prompt Builder que compila essas seções em
texto, um ciclo explícito de Rascunho → Playground → Publicar, e histórico de
versões. A arquitetura de experiência é inspirada na aba "Editar" da Assis
(SaaS de terceiros usado hoje para outro agente da empresa), mas usando
integralmente o design system, sidebar e componentes já existentes em
`apps/web` — nenhuma cor, texto ou identidade visual da Assis é copiada.

Um "Trainer conversacional" (chat em linguagem natural que edita a
configuração propondo diffs) é a evolução natural desta base, mas fica para
uma Fase 2 — decisão explícita do usuário, registrada na seção "Fases e
não-escopo".

## Escopo desta fase (Fase 1)

Entregar o núcleo **Editar → Testar → Publicar → Versionar** funcionando em
produção, sem quebrar nada do que já existe. Fora de escopo nesta rodada:
Trainer conversacional, MCP, sub-agentes, Instagram, e-mail, rotinas,
automações genéricas, analytics avançado, e qualquer ferramenta nova de
handoff/transferência-para-humano (hoje não existe uma; o módulo de regras
correspondente fica documental/instrutivo, sem acionar nada de verdade —
decisão explícita do usuário).

## Arquitetura atual (achados relevantes)

- `agents` (`supabase/migrations/00004_agents.sql`): única tabela, nunca
  alterada desde a criação. Colunas: `name, description, system_prompt,
  model, provider, temperature, max_tokens, tools_config jsonb, is_active`.
  É esta linha que `apps/worker/src/agents/agent-runner.ts` lê a cada
  mensagem via `getAgentById`.
- Compilação do prompt hoje é trivial: `buildSystemPrompt(basePrompt, now)`
  (`agent-runner.ts:49-51`) só concatena `agents.system_prompt` com uma linha
  de data/hora (`formatDateTimeForPrompt`, `packages/shared/src/date.ts`).
  Não há nenhuma outra montagem — o texto salvo é o texto usado.
- Tools reais, registradas em `apps/worker/src/agents/tools/registry.ts`
  (`buildToolsForAgent`), ligadas por 4 flags booleanas em
  `agents.tools_config`: `search_knowledge` (busca vetorial real via
  pgvector, `knowledge_chunks`), `search_faq` (score por substring em
  `knowledge_faqs`, sem embeddings), `send_catalog_photo` (busca + envio de
  foto de veículo via catálogo externo), `create_task` (cria/deduplica linha
  em `tasks`). **Não existe nenhuma tool de handoff/transferência para
  humano** — existe apenas um estado de "human takeover" na conversa
  (checado em `process-message.ts:69`), que nenhuma tool aciona.
- Conhecimento: `knowledge_documents` + `knowledge_chunks` (busca vetorial
  real, sem `is_active` por documento) e `knowledge_faqs` (busca por
  keyword, tem `is_active`). Duas mecânicas de recuperação diferentes para
  conteúdo conceitualmente parecido — mantidas como estão nesta fase.
- Escritas de agente hoje são feitas **direto do browser via Supabase**
  (`apps/web/src/app/(dashboard)/agents/[agentId]/page.tsx`,
  `agents/new/page.tsx`) — sem rota em `apps/api`, sem checagem de
  organização no servidor além da RLS genérica. Não há `created_by` nem
  `updated_by` em `agents`.
- **Não existe nenhum conceito de draft/publish/versão em todo o
  repositório.** O precedente mais próximo é `task_events` (log de eventos
  de uma tarefa) — é um log de ações, não um snapshot versionado.
- Design system (`apps/web/src/components/ui`): `Tabs` existe
  (`@base-ui/react/tabs`) mas não é usado em nenhuma tela hoje. `Dialog`,
  `Sheet`, `Switch`, `Select`, `Card`, `Badge` já são usados (Tarefas,
  Inbox). Não existe `Slider`, `Popover` nem `AlertDialog`.
- Padrão de formulário existente (`agent-form.tsx`): `react-hook-form` +
  `zodResolver` sobre schemas de `@aula-agente/shared`
  (`createAgentSchema`/`updateAgentSchema`).

## Modelo de dados

`agents` **não muda de formato**. Ela continua sendo a linha "publicada" —
o worker nunca lê nada além dela, nunca muda seu comportamento de leitura.

Duas tabelas novas, nesta ordem de criação (a segunda referencia a
primeira):

```sql
-- 00012_agent_versions.sql
CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version integer NOT NULL,
  changelog text NOT NULL DEFAULT '',
  config_snapshot jsonb NOT NULL,
  compiled_system_prompt text NOT NULL,
  model_settings jsonb NOT NULL,
  tools_config jsonb NOT NULL,
  published_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);
CREATE INDEX idx_agent_versions_agent ON agent_versions(agent_id, version DESC);
```

```sql
-- 00013_agent_configs.sql
CREATE TABLE agent_configs (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  base_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
  identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  personality jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  knowledge jsonb NOT NULL DEFAULT '{}'::jsonb,
  playbook jsonb NOT NULL DEFAULT '{}'::jsonb,
  tools_config jsonb NOT NULL DEFAULT
    '{"search_knowledge": true, "search_faq": true, "send_catalog_photo": true, "create_task": true}'::jsonb,
  model_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);
CREATE TRIGGER trg_agent_configs_updated_at BEFORE UPDATE ON agent_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

`base_version_id` (ajuste pedido pelo usuário) registra de qual versão
publicada o rascunho partiu. Usos:

- **Restore**: restaurar a versão N para rascunho grava
  `base_version_id = N` junto com os campos copiados do snapshot.
- **Comparação**: o diff mostrado no dialog de "Publicar" e o contador de
  "X alterações não publicadas" comparam o rascunho atual contra
  `config_snapshot` da versão em `base_version_id` (ou contra a última
  versão publicada, se `base_version_id` for nulo).
- **Conflito de edição**: se `base_version_id` do rascunho for diferente da
  versão mais recente publicada daquele agente (outro usuário publicou
  enquanto você editava), a UI avisa antes de permitir publicar — organizações
  têm múltiplos membros com CRUD igual em `agents` (RLS por papel
  owner/admin/agent), então isso é um cenário real, não hipotético.

Formato interno de `rules` (exemplo, dentro do jsonb — cada item de lista
tem `id` estável para permitir métricas futuras, ex. qual objeção aparece
mais em conversas):

```jsonc
{
  "transferencia_para_humano": [
    { "id": "negociacao-complexa", "label": "Negociação complexa", "instrucao": "...", "ativo": true }
  ],
  "promessas_proibidas": [
    { "id": "valores-nao-cadastrados", "texto": "Nunca inventar valores...", "ativo": true }
  ],
  "regras_por_tipo": [
    { "id": "consorcio", "categoria": "Consórcio", "instrucao": "...", "ativo": true }
  ],
  "preco_desconto": {
    "pode_autonomo": "...", "exige_humano": "...", "nunca_pode": "...", "observacoes": "..."
  },
  "objecoes": [
    {
      "id": "preco-alto", "nome": "Preço alto", "ativo": true,
      "como_identificar": "...", "orientacao": "...",
      "pergunta_diagnostico": "...", "quando_escalar": "..."
    }
  ]
}
```

`knowledge` guarda apenas referências/conteúdo leve, não duplica o que já
tem tabela própria:

```jsonc
{
  "precos_notas": "texto livre (nova seção, sem tabela própria)",
  "links": [{ "id": "...", "titulo": "...", "url": "...", "ativo": true }],
  "documentos_ativos": true,
  "faqs_ativas": true
}
```

**Criação preguiçosa do rascunho**: `agent_configs` só passa a existir para
um agente na primeira vez que sua tela de edição é aberta (ou no primeiro
`PATCH`). Nesse momento, `model_settings` e `tools_config` são semeados a
partir dos valores atuais de `agents` (já são dados estruturados, não
precisam de sugestão de IA); `identity`/`personality`/`rules`/`playbook`
nascem vazios e são preenchidos pelo fluxo de "Importação do System Prompt
atual" descrito abaixo. Isso evita publicar um `model_settings` vazio antes
do usuário nunca ter aberto a tela nova.

`Base de Conhecimento` e `FAQ` continuam usando as tabelas e componentes que
já existem (`knowledge_documents`/`knowledge_chunks` via `DocumentUpload`,
`knowledge_faqs` via `FaqManager`) — a nova tela só realoca esses
componentes para dentro da aba Conhecimento; o rascunho apenas guarda se
essas fontes estão ativas para o agente, não o conteúdo em si.

Sessões de teste do Playground, isoladas de conversas reais:

```sql
-- 00014_agent_playground.sql
CREATE TABLE agent_playground_sessions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_playground_messages (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  session_id uuid NOT NULL REFERENCES agent_playground_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_playground_messages_session ON agent_playground_messages(session_id, created_at);
```

Cada entrada de `tool_calls` (ajuste pedido pelo usuário — diferenciar
execução real de simulada): `{ "tool_name": "create_task", "input": {...},
"output": {...}, "mode": "real" | "simulated", "executed_at": "..." }`.

RLS de todas as tabelas novas segue exatamente o padrão de
`00008_rls_policies.sql` (`get_user_org_ids()`), igual às tabelas de tasks.

## Prompt Builder

Função pura nova, `packages/shared/src/prompt-builder.ts`:

```ts
export function compileSystemPrompt(config: AgentConfigDraft): string
```

Sem I/O, testável isoladamente (mesmo espírito de `task-helpers.ts`). Monta,
em ordem: Identidade → Personalidade → Regras (transferência, promessas,
por-tipo, preço/desconto, objeções ativas apenas) → Playbook → notas de
Preços/Links (inline, por serem pequenas e sempre relevantes — o mesmo
raciocínio de "Descrição sempre visível" da Assis) → rodapé de data/hora
(reaproveita `formatDateTimeForPrompt`, sem mudanças). Documentos e FAQs
**não** são inlined — continuam recuperados sob demanda pelas tools
existentes, exatamente como hoje.

`buildSystemPrompt` em `agent-runner.ts` não muda: ele sempre recebeu texto
pronto e continua recebendo texto pronto — a compilação passa a acontecer
antes, no momento da publicação, não a cada mensagem.

"Visualizar prompt compilado" na UI chama `compileSystemPrompt` sobre o
rascunho atual, somente leitura.

## Camada de API (`apps/api`)

Novas rotas (padrão idêntico ao já usado por Tarefas: `apiFetch` do
frontend, checagem de organização no servidor):

- `GET /agents/:id/config` — retorna o rascunho atual (`agent_configs`) e a
  contagem de alterações pendentes (diff contra `base_version_id`).
- `PATCH /agents/:id/config` — atualiza uma ou mais seções do rascunho
  (`identity`, `personality`, `rules`, `knowledge`, `playbook`,
  `tools_config`, `model_settings`). Escrita simples, sem versão nova.
- `POST /agents/:id/config/publish` — publica (ver transação abaixo). Body:
  `{ changelog: string }`.
- `GET /agents/:id/versions` — lista versões (paginada).
- `GET /agents/:id/versions/:versionId` — detalhe de uma versão + diff
  contra a versão anterior.
- `POST /agents/:id/versions/:versionId/restore` — copia o snapshot da
  versão para `agent_configs`, setando `base_version_id = versionId`. Não
  publica sozinho — vira só mais um estado de rascunho.
- `POST /agents/:id/config/import-suggestion` — ver seção de migração
  abaixo.
- `POST /agents/:id/playground/sessions` — cria sessão de teste.
- `POST /agents/:id/playground/sessions/:sessionId/messages` — envia
  mensagem de teste, roda o agente em modo sandbox (ver Playground).

`is_active` continua sendo escrito imediatamente (fora do ciclo de
rascunho) — é uma ação operacional/de segurança (pausar o agente), não uma
mudança de conteúdo; não faz sentido ela ficar revertida por um
"Descartar rascunho".

### Publish transacional (ajuste pedido pelo usuário)

Compilar o prompt, atualizar `agents`, gravar o snapshot em
`agent_versions` e atualizar `agent_configs.base_version_id` precisam
acontecer juntos ou não acontecer. Como o cliente admin usa `supabase-js`
(sem transação multi-statement nativa do lado do Node), a implementação é
uma **função Postgres** — mesmo padrão já usado em
`supabase/migrations/00009_functions.sql` (`search_knowledge_chunks`,
`get_user_org_ids()`):

```sql
CREATE FUNCTION publish_agent_config(
  p_agent_id uuid, p_changelog text, p_compiled_prompt text,
  p_config_snapshot jsonb, p_model_settings jsonb, p_tools_config jsonb,
  p_published_by uuid
) RETURNS agent_versions
LANGUAGE plpgsql AS $$
DECLARE
  v_version integer;
  v_row agent_versions;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM agent_versions WHERE agent_id = p_agent_id;

  UPDATE agents SET
    system_prompt = p_compiled_prompt,
    model = p_model_settings->>'model',
    provider = p_model_settings->>'provider',
    temperature = (p_model_settings->>'temperature')::real,
    max_tokens = (p_model_settings->>'max_tokens')::integer,
    tools_config = p_tools_config
  WHERE id = p_agent_id;

  INSERT INTO agent_versions (
    agent_id, organization_id, version, changelog, config_snapshot,
    compiled_system_prompt, model_settings, tools_config, published_by
  )
  SELECT p_agent_id, organization_id, v_version, p_changelog, p_config_snapshot,
         p_compiled_prompt, p_model_settings, p_tools_config, p_published_by
  FROM agents WHERE id = p_agent_id
  RETURNING * INTO v_row;

  UPDATE agent_configs SET base_version_id = v_row.id WHERE agent_id = p_agent_id;

  RETURN v_row;
END;
$$;
```

Uma função plpgsql executa como uma transação implícita — qualquer exceção
(ex. constraint violation) reverte todas as três escritas automaticamente.
A rota `POST /agents/:id/config/publish` faz só: montar os parâmetros
(incluindo `compileSystemPrompt(draft)` chamado em Node antes do RPC, já
que é lógica de negócio e precisa ser testável fora do Postgres) e chamar
`.rpc("publish_agent_config", {...})`. Nenhuma escrita solta fora dessa
função.

## Playground

Nova rota reaproveita o núcleo de `agent-runner.ts` (extraído para uma
função compartilhada — pequeno refactor seguro, sem mudar comportamento:
hoje `createModel`/`generateText`/`formatHistoryForLLM` são privados ao
worker; passam a ser importáveis também pela API). Diferenças do caminho
real:

- `system` = `compileSystemPrompt(rascunho atual)`, não o publicado.
- Tools construídas com uma flag `sandbox: true` passada para
  `buildToolsForAgent`: `search_knowledge`, `search_faq`,
  `search_catalog` continuam **reais** (são só leitura, e o teste precisa
  de respostas realistas); `create_task` e `send_catalog_photo` (efeitos
  colaterais reais — criam linha em `tasks` e enviam mensagem de
  WhatsApp de verdade) viram handlers mock que retornam um payload de
  sucesso simulado, sem tocar `tasks` nem a fila de envio.
- Cada chamada de tool grava uma entrada em
  `agent_playground_messages.tool_calls` com `mode: "real"` ou
  `"simulated"` (ajuste pedido pelo usuário) — a UI mostra isso junto ao
  trace de raciocínio, igual ao "TOOLS (n)" que vimos na Assis, mas
  deixando explícito quais chamadas foram de verdade.
- Histórico da conversa de teste vem de `agent_playground_messages`, nunca
  de `messages`/`conversations` reais. "Nova conversa" cria uma nova
  `agent_playground_sessions`.

## Frontend

Rotas novas, seguindo o padrão já existente de pastas irmãs sob
`apps/web/src/app/(dashboard)/agents/[agentId]/` (mesmo padrão de
`knowledge/` hoje):

- `editar/page.tsx` — layout de 3 colunas (nav esquerda | editor central |
  Playground direita) via CSS grid responsivo; abaixo de um breakpoint, o
  Playground vira o conteúdo de um `Sheet` (componente já usado no
  "Detalhes da conversa" do Inbox) acionado por um botão.
- `historico/page.tsx` (ou `Dialog` — a decidir no plano; conceitualmente
  mais perto de um fluxo focado "escolher versão → ver diff → restaurar",
  o que favorece `Dialog`).
- `page.tsx` (atual) vira um redirect simples para `editar/`.

Navegação superior "Editar | Playground | Histórico": primeiro uso real do
componente `Tabs` já existente em `components/ui/tabs.tsx`.

Nav esquerda (Geral/Personalidade/Regras/Conhecimento/Playbooks/
Ferramentas): lista vertical com estado manual (mesmo padrão dos filtros de
Tarefas/Inbox — não é um componente novo), cada item troca o que renderiza
no centro.

Componentes novos e genéricos (reaproveitados pelos 5 módulos que
precisam de "adicionar/editar/remover item" — objeções, gatilhos de
handoff, promessas proibidas, regras por tipo, gírias proibidas):

- `components/agents/list-editor.tsx` (`<ListEditor>`), item com campos
  configuráveis, toggle ativo/inativo, e botão "+ Novo item".
- `components/agents/tag-input.tsx` (`<TagInput>`), para gírias proibidas.

Playground: novo `PlaygroundPanel`, reaproveitando o estilo visual de
`MessageBubble` (bolhas por papel) e o layout de input do `ChatPanel`, mas
falando com as rotas de playground em vez de Supabase realtime, e
mostrando o trace de tools (real vs. simulado).

Indicador de rascunho: barra fixa no topo da aba Editar com
`Badge` mostrando "N alterações não publicadas", botão "Descartar"
(confirmação dentro de um `Dialog` simples — não existe `AlertDialog` no
design system) e botão "Publicar" (abre `Dialog` com lista de seções
alteradas + `Textarea` de changelog).

Contador ("N configurações · ~Xk caracteres · ~Y tokens estimados"):
calculado no cliente a partir do JSON do rascunho; estimativa de tokens por
heurística simples (chars/4), rotulada como estimativa.

`Conhecimento`: a aba reaproveita `DocumentUpload` e `FaqManager` tal como
existem hoje, apenas realocados para dentro da nova tela; a página antiga
`/agents/[agentId]/knowledge` continua funcionando durante a transição
(pode ser removida depois, fora de escopo desta spec).

## Migração do System Prompt atual

Sem classificação automática silenciosa (ajuste pedido pelo usuário). Fluxo:

1. Tela "Importar configuração atual" mostra o texto de
   `agents.system_prompt` de hoje ao lado das seções vazias do rascunho.
2. `POST /agents/:id/config/import-suggestion` chama uma vez um LLM para
   **sugerir** como dividir esse texto entre Identidade/Personalidade/
   Regras/Playbook, e devolve essa sugestão como um objeto no mesmo formato
   de `agent_configs` — **sem gravar nada**.
3. A UI mostra a sugestão lado a lado com o texto original, editável campo
   a campo, com um preview de `compileSystemPrompt(sugestão)` para conferir
   visualmente que o resultado bate com o comportamento atual.
4. Só quando o usuário clica "Aplicar ao rascunho" é que um `PATCH
   /agents/:id/config` normal (o mesmo endpoint de qualquer edição manual)
   grava as seções revisadas.
5. `agents.system_prompt` não é tocado em nenhum momento deste fluxo — só
   o primeiro `Publicar` depois disso muda a linha ao vivo.

Não há feature flag: como a linha publicada só é escrita no momento em que
o usuário publica de propósito, o comportamento em produção fica
inalterado até essa decisão explícita.

## Segurança / não quebrar produção

- `agents`: mesmo formato, mesmas colunas, mesmos defaults.
- `agent-runner.ts`, `buildSystemPrompt`, `buildToolsForAgent`: não mudam
  de comportamento no caminho real (o `sandbox: true` é um parâmetro novo
  usado só pelo Playground).
- As 4 tools existentes: mesmo formato de `tools_config`, mesmo
  comportamento — só passam a ser editadas pelo fluxo de rascunho em vez
  dos `Switch` soltos do formulário antigo.
- `/agents/[agentId]/knowledge` continua funcionando durante a transição.
- Único ponto que escreve na linha ao vivo é `publish_agent_config`, uma
  função transacional só.

## Fases e não-escopo

**Fase 1** (esta spec): editor visual modular, Prompt Builder, API de
rascunho/publish/versão, Playground com sandbox de tools, importação
assistida do prompt atual.

**Fase 2** (fora desta spec, arquitetura já compatível): Trainer
conversacional. Lê o mesmo `agent_configs` (nenhum "prompt do Trainer"
separado). Sua ferramenta de "propor mudança" retorna um diff
`{caminho, antes, depois, motivo}` sem gravar nada; aplicar ao rascunho é
sempre um clique humano que chama o mesmo `PATCH /agents/:id/config` desta
fase — o Trainer nunca tem escrita direta nem pode publicar. "Analisar
conversas reais" e "Caçar inconsistências" são fluxos do mesmo agente
Trainer sobre dados já existentes (`conversations`/`messages` para o
primeiro, o próprio `agent_configs` para o segundo). Histórico de chat do
Trainer, se necessário, fica em uma tabela nova e leve
(`agent_trainer_messages`), totalmente separada de `messages` reais.

Também fora de escopo nesta rodada, por pedido explícito do usuário: MCP,
sub-agentes, Instagram, e-mail, rotinas, automações genéricas, analytics
avançado, e qualquer tool nova de handoff (o módulo correspondente fica
documental/instrutivo apenas).
