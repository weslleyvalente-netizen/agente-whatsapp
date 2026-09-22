# Integração do CRM (assistente-mt) dentro do apps/web — Design

**Data:** 2026-09-22 (revisado no mesmo dia após achar o `crm-sync.ts`)
**Status:** Parcialmente superado — ver `specs/2026-09-22-oportunidades-comerciais-design.md`.
A seção "Funil de vendas" deste spec não deve ser implementada como está: a
Oportunidade nasce nativa no `aula-agente`, não aponta para o `deals` do CRM
standalone. A seção "Contatos" continua válida (ver nota no plano
correspondente, `plans/2026-09-22-crm-contacts-deals-port.md`).

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
  depois.
- `apps/web` já tem rotas `/tasks` e `/team` com **conceitos diferentes**
  dos do CRM (tarefas operacionais da equipe vs. lembretes automáticos de
  "novo contato"; membros da organização vs. lista simples de perfis
  ativos). Decisão do usuário: usar os sistemas que já existem no agente
  para tarefas e equipe, e **descartar** os equivalentes do CRM — sem
  acumular menus/conceitos duplicados.
- **Correção importante, achada só depois da primeira versão deste spec:**
  `wa_contacts` (tabela do agente) e `contacts` (tabela do CRM) **não são
  o mesmo conceito nem devem virar um só**. Existe desde 17/jul um spec e
  implementação aprovados (`specs/2026-07-17-crm-whatsapp-integration-design.md`,
  código em `apps/api/src/integrations/crm-sync.ts`) que já resolveram
  exatamente essa colisão: a tabela do agente foi renomeada de `contacts`
  para `wa_contacts` de propósito, e existe uma sincronização **unidirecional
  já rodando em produção** — toda vez que chega a primeira mensagem de um
  contato novo no WhatsApp, `syncContactToCrm()` cria (ou reaproveita, por
  telefone) uma linha em `contacts` (CRM) e uma `activities` com título
  "Novo contato via WhatsApp". É esse mecanismo que gerou os 929 contatos e
  a lista de tarefas "Novo contato via WhatsApp" vistos ao vivo no CRM
  standalone. Fundir as duas tabelas (como a primeira versão deste spec
  propunha) quebraria esse pipeline e exigiria migrar dados sem
  necessidade nenhuma. **Decisão corrigida: as páginas portadas continuam
  lendo as tabelas do CRM (`contacts`, `deals`, `profiles`) como estão —
  zero migração, zero tabela nova.** Não existe hoje um link explícito
  (FK) entre um `contacts.id` do CRM e o `wa_contacts.id` de origem — só o
  telefone em comum usado no sync. Isso é uma limitação conhecida, fora de
  escopo aqui (nenhuma funcionalidade pedida depende desse link).
- Login único já existe de graça: os dois apps usam o mesmo projeto
  Supabase Auth (mesma tabela `auth.users`). O usuário logado no
  `apps/web` é o mesmo `auth.uid()` que a RLS do CRM (`is_active_profile`)
  já reconhece — confirmado ao ver os dados reais do CRM standalone
  carregarem com a sessão salva no navegador.
- O bug do UUID cru aparecendo no card do Kanban vem do `AssigneeSelect`,
  que busca só `profiles` com `is_active = true`; quando o `owner_id` de
  um negócio não bate com nenhum perfil ativo carregado, o componente de
  seleção cai no fallback de mostrar o valor bruto. Como `deals.owner_id`
  continua apontando para `profiles` (schema do CRM, sem mudança), o
  conserto fica contido nesse componente: garantir que o responsável
  atual do negócio apareça na lista mesmo se estiver inativo, em vez de
  trocar a fonte de dados para outro conceito.

## Modelo de dados

**Nenhuma migração. Nenhuma tabela nova.** As páginas portadas leem e
escrevem diretamente nas tabelas que já existem no mesmo projeto Supabase
e já são usadas pelo CRM standalone: `contacts`, `deals`, `profiles`
(schema definido em `assistente-mt/supabase/migrations/0001_profiles.sql`
e `0003_crm_tables.sql`). RLS dessas tabelas continua exatamente como
está (`is_active_profile(auth.uid())`) — já testada e funcionando com o
login do usuário.

A tabela `activities` (as "tarefas" do CRM) **não é portada** — descartada
em favor da `tasks` que já existe em `apps/web`, por decisão do usuário.
O `crm-sync.ts` (`apps/api`) continua escrevendo em `activities` sem
mudança nenhuma (é dele que vêm os itens "Novo contato via WhatsApp" que
o usuário já usa) — só não é mais assim que a UI de tarefas do produto
integrado é exibida.

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

- `DealKanban` / `DealCard` — copiado praticamente sem mudança (mesma
  tabela `deals`, mesmas colunas).
- `DealForm` (criação de negócio) — sem mudanças.
- `AssigneeSelect` → corrigido para não perder o responsável atual do
  card quando ele não está mais entre os perfis ativos: busca os perfis
  ativos normalmente para a lista de opções, e adicionalmente busca por
  `id` o perfil do `value` atual caso ele não esteja nessa lista,
  incluindo-o como opção extra (com indicação de inativo). Resolve o bug
  do UUID cru sem mudar de onde vem o dado.
- Lista de Contatos — copiada da `assistente-mt`, mesma tabela
  `contacts`.

## Erros e permissões

Segue o padrão já existente no CRM standalone (mantido, sem mudança): RLS
nega qualquer acesso a `contacts`/`deals` se `is_active_profile(auth.uid())`
for falso; erros de mutação (drag-and-drop de estágio, troca de
responsável) mostrados via `alert()`, igual ao `DealKanban` original já
faz hoje.

## Teste

Rodar local (`pnpm dev --filter=@aula-agente/web`) contra o Supabase real
do projeto (mesmo banco, mesmos `contacts`/`deals` já existentes,
incluindo o negócio "INSS" real) antes de qualquer deploy. Deploy para
`https://agente-whatsapp-web.qinw5t.easypanel.host` só depois de validado
localmente e aprovado pelo usuário. O CRM standalone continua no ar
durante esse período, sem alterações — e o `crm-sync.ts` continua
escrevendo normalmente em `contacts`/`activities`, sem impacto.

## Fora de escopo (sub-projetos futuros, desenhados separadamente depois)

- Ajustar funções/lógica de negócio do funil e contatos para o processo
  real de vendas.
- Automações (ex: criar negócio automaticamente a partir de um novo
  contato, notificações, integrações).
- Redesign visual moderno (do agente inteiro, não só do que foi portado
  aqui).
- Decisão de desativar o CRM standalone (`assistentemt-crm`).
