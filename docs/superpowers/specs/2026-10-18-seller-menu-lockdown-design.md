# Restringir menu e escrita de vendedores (papel `agent`)

**Problema:** vendedores (organization_members.role = 'agent') veem no menu Agentes, Instâncias, Custos, Equipe e Configurações, e as políticas RLS genéricas (00008) deixam qualquer membro editar/apagar `agents`, `evolution_instances` e demais tabelas de configuração do agente. Risco: vendedor altera o prompt da IA ou desconecta o WhatsApp.

## 1. Menu e rotas (apps/web)
- `components/layout/app-sidebar.tsx` (e o menu do celular `mobile-nav.tsx`, que reaproveita `SidebarBody`): marcar `managerOnly: true` em Agentes, Instâncias, Custos, Equipe, Configurações. O vendedor fica com Início, Conversas, Funil de vendas, Tarefas, Catálogo.
- Esconder o menu não basta: as páginas `/agents/**`, `/instances/**`, `/costs`, `/team`, `/settings`, `/calls` devem redirecionar vendedores para `/inbox` (guarda client-side via `useMyRole`, sem piscar conteúdo restrito enquanto o papel carrega; reaproveite o padrão existente em `/calls` se houver). Dono/admin não mudam.

## 2. Banco (migration nova `supabase/migrations/20261019120000_manager_only_config_writes.sql`, NÃO aplicar)
- Para `agents`, `evolution_instances` e as demais tabelas de configuração do agente que hoje usam a política genérica ou equivalente (liste-as lendo `supabase/migrations`: agent_versions, configuração/imagens/ferramentas do agente, knowledge_* se fizer sentido): manter SELECT para membros da organização (a conversa/funil mostra nome do agente/instância), mas INSERT/UPDATE/DELETE só para `role IN ('owner','admin')` na organização. Padrão: `DROP POLICY IF EXISTS` das políticas de escrita atuais e recriar com a checagem de papel; idempotente.
- NÃO tocar em tabelas que o vendedor precisa escrever no dia a dia: conversations, messages, wa_contacts, conversation_notes, opportunities, tasks, call logs, etc. O backend (API/worker) usa service role e não é afetado.
- Incluir no arquivo um bloco de comentário com como reverter (recriar as políticas antigas).
- Confirme com testes (pglite/SQL tests existentes em `packages/database/src/sql`, siga o padrão) que: membro `agent` NÃO consegue UPDATE/DELETE em agents/evolution_instances, owner/admin conseguem, SELECT segue funcionando para todos.

## 3. Notificações push sem Configurações
- O card "Notificações neste aparelho" (hoje em `settings/page.tsx`) precisa ser acessível ao vendedor: extraia para um componente reutilizável e ofereça-o também por um item "Notificações" no menu do usuário (`components/layout/user-nav.tsx`) que abre um diálogo/página leve (`/notificacoes`, visível a todos) com o card. Dono/admin continuam podendo vê-lo em Configurações (ou só no novo lugar, evitando duplicar: prefira mover para o novo lugar e manter um link em Configurações).

## API
Verifique se as rotas de `costs`, `agent-config`, `instances`, `invitations` e equipe exigem papel de gerente onde faz sentido; se alguma devolve dado/ação sensível a `agent`, adicione a checagem `isManager` (apps/api/src/lib/lead-visibility) com teste. Não quebre fluxos de vendedor (conversas, mensagens, tarefas, funil).

## Testes e restrições
Vitest nos padrões existentes (guarda de rota, filtro do menu por papel, componente/ação do menu do usuário, SQL). `pnpm -r typecheck` e testes dos pacotes tocados verdes; rode `next build` do web. Não aplicar migration, não tocar produção, não fazer push, sem segredos.
