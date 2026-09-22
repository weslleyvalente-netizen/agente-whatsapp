# Integração do CRM (assistente-mt) dentro do apps/web — Design

**Data:** 2026-09-22
**Status:** Desenhado, aguardando revisão do usuário antes de virar plano de implementação

## Contexto

Hoje existem dois produtos separados, rodando como dois serviços distintos
no mesmo EasyPanel (servidor `187.77.226.182`), compartilhando o mesmo
projeto Supabase (`fwwulkmriqkrzozcsqnx.supabase.co`):

- **Agente de WhatsApp** ("aula-agente", monorepo em
  `/Users/weslleyvalente/Agente IA/superpowers`, apps `web`/`api`/`worker`)
  — quase pronto, em produção, atende clientes reais via WhatsApp.
  Deployado em `https://agente-whatsapp-web.qinw5t.easypanel.host`.
- **CRM** ("crm-implementation", repo próprio em
  `/Users/weslleyvalente/assistente-mt`) — funcional mas visualmente
  genérico (boilerplate do `create-next-app` nunca trocado), com Contatos,
  Funil de vendas (Kanban), Tarefas e Equipe. Deployado separadamente em
  `https://assistentemt-crm.qinw5t.easypanel.host`, exige login próprio.

O usuário quer que os menus do CRM apareçam dentro do site do agente de
WhatsApp, com login único (o do agente) — em vez de manter duas telas de
login e dois produtos desconexos. Este spec cobre o primeiro sub-projeto:
**portar Contatos e Funil de vendas para dentro do `apps/web`**. Ajustes de
funcionalidade, automações e um visual mais moderno ficam para
sub-projetos seguintes, desenhados depois que esta integração estiver no
ar.

O CRM standalone (`assistente-mt`) continua rodando em paralelo por
enquanto — a decisão de desativá-lo fica para depois que a versão
integrada estiver validada.

## Descobertas que moldaram o desenho

- `apps/web` já é **multi-tenant de verdade** (`organizations`,
  `organization_members`, `OrganizationProvider`) — não é estrutura não
  usada. O usuário confirmou: hoje é uma organização só (o próprio
  negócio), mas pretende replicar o produto para vender a outras empresas
  depois. Por isso, toda tabela nova leva `organization_id` desde já,
  mesmo optando por não fazer o CRM completo já herdar todo o
  fluxo de convite/troca de organização usado no resto do produto.
- `apps/web` já tem rotas `/tasks` e `/team` com **conceitos diferentes**
  dos do CRM (tarefas operacionais da equipe vs. lembretes automáticos de
  "novo contato"; membros da organização vs. lista simples de perfis
  ativos). Decisão do usuário: usar os sistemas que já existem no agente
  para tarefas e equipe, e **descartar** os equivalentes do CRM — sem
  acumular menus/conceitos duplicados.
- `apps/web` já tem uma tabela `wa_contacts` (telefone, nome, foto,
  `organization_id`), já usada pela tabela `tasks` (`contact_id`) e pelo
  Inbox. É o mesmo tipo de dado que o `contacts` do CRM guarda — evita
  criar uma segunda lista de contatos desconectada da primeira.
- O bug do UUID cru aparecendo no card do Kanban (visto ao vivo no CRM
  standalone) vem do `AssigneeSelect`, que só busca `profiles` com
  `is_active = true`; quando o `owner_id` de um negócio não bate com
  nenhum perfil ativo carregado, o componente de seleção cai no
  fallback de mostrar o valor bruto. Resolvido ao trocar a fonte de dados
  para a lista de membros da organização (o mesmo mecanismo que a página
  de Tarefas já usa para resolver nomes de responsável).

## Modelo de dados

**`wa_contacts`** (já existe) — duas colunas novas, nullable, sem impacto
no que já usa a tabela:

```sql
alter table wa_contacts
  add column email text,
  add column company text;
```

**`deals`** (nova tabela, em `apps/web`'s aula-agente
`supabase/migrations`, não no repo do CRM):

```sql
create table deals (
  id uuid primary key default extensions.uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references wa_contacts(id) on delete cascade,
  title text not null,
  value numeric,
  stage text not null default 'novo'
    check (stage in ('novo', 'em_contato', 'negociacao', 'fechado_ganho', 'fechado_perdido')),
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_deals_org_stage on deals(organization_id, stage);
create index idx_deals_contact on deals(contact_id);

create trigger trg_deals_updated_at
  before update on deals
  for each row execute function update_updated_at();
```

Diferenças deliberadas em relação ao `deals` do CRM standalone:
`contact_id` aponta para `wa_contacts` (não uma tabela `contacts`
separada); `owner_id` aponta para `auth.users` (mesmo padrão que
`tasks.assignee_id`, não `profiles`); `organization_id` obrigatório desde
o início.

**RLS**: segue o padrão de organização já usado no resto do banco
(policy baseada em `organization_members`, não o helper
`is_active_profile` do CRM standalone — esse conceito de "perfil ativo"
não é portado).

A tabela `activities` (as "tarefas" do CRM) e a tabela `profiles`/conceito
de "perfil ativo" do CRM **não são portadas** — substituídas pelo que já
existe (`tasks`, `organization_members`).

## Rotas e menu

Duas rotas novas dentro do grupo `(dashboard)` existente — herdam a
autenticação já feita em `(dashboard)/layout.tsx`, nada novo a configurar:

- `/contacts` — "Contatos"
- `/deals` — "Funil de vendas"

No `AppSidebar`, inseridos logo após "Conversas" (mantendo o agrupamento
de itens ligados a clientes), sem criar submenu — a lista continua flat:

```
Início, Conversas, Contatos, Funil de vendas, Tarefas, Catálogo,
Agentes, Instâncias, Custos, Equipe, Configurações
```

## Componentes

Portados de `assistente-mt` para `apps/web`, adaptando fonte de dados e
imports (ambos os apps usam o mesmo kit de UI — `@base-ui/react`,
mesmos componentes `components/ui/*` — então o visual sai idêntico ao
que já existe, sem retrabalho de design agora):

- `DealKanban` / `DealCard` — troca a query de `deals` (nova tabela,
  já com `contact_id` → `wa_contacts`).
- `DealForm` (criação de negócio) — sem mudanças de lógica, só o alvo
  da tabela.
- `AssigneeSelect` → adaptado para buscar `organization_members` (com
  nome resolvido do mesmo jeito que a página de Tarefas já resolve nomes
  de responsável) em vez de `profiles.is_active`. Corrige o bug do UUID
  na raiz, não só neste componente novo.
- Lista de Contatos — tabela nome/telefone/e-mail/empresa/ações, lendo
  `wa_contacts` em vez de `contacts`.

## Erros e permissões

Segue o padrão já existente em `apps/web`: RLS nega acesso fora da
organização; erros de mutação (drag-and-drop de estágio, troca de
responsável) mostrados via `alert()`, igual ao `DealKanban` original já
faz hoje.

## Teste

Rodar local (`pnpm dev --filter=@aula-agente/web`) contra o Supabase real
do projeto (mesmo banco, mesmos dados de `wa_contacts` já existentes)
antes de qualquer deploy. Deploy para
`https://agente-whatsapp-web.qinw5t.easypanel.host` só depois de validado
localmente e aprovado pelo usuário. O CRM standalone continua no ar
durante esse período, sem alterações.

## Fora de escopo (sub-projetos futuros, desenhados separadamente depois)

- Ajustar funções/lógica de negócio do funil e contatos para o processo
  real de vendas.
- Automações (ex: criar negócio automaticamente a partir de um novo
  contato, notificações, integrações).
- Redesign visual moderno (do agente inteiro, não só do que foi portado
  aqui).
- Decisão de desativar o CRM standalone (`assistentemt-crm`).
