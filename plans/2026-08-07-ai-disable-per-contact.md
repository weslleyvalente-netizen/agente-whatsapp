# Desativar a IA Permanentemente por Contato — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma forma permanente (sem expirar, por contato, não por
conversa) de desligar a Helena para um número de telefone específico,
independente do mecanismo temporário de takeover já existente.

**Architecture:** Três colunas novas em `wa_contacts` (migration), checadas
em dois pontos de guarda já existentes (worker + webhook) que hoje só
checam `is_human_takeover`, mais UI no cabeçalho do chat e um badge na
lista de conversas. Escrita direto via Supabase JS do cliente, sem rota
REST nova — mesmo padrão do takeover temporário já em produção.

**Tech Stack:** Supabase (Postgres + RLS), Fastify (apps/api), BullMQ
worker (apps/worker), Next.js App Router (apps/web), Supabase JS client.

## Global Constraints

- Spec: `specs/2026-08-07-ai-disable-per-contact-design.md`. Leia antes de
  começar se algo abaixo parecer ambíguo.
- **Esta é a primeira tarefa desta sessão que toca banco de dados.** A
  regra permanente deste projeto é: nunca aplicar uma migration no banco
  Supabase real sem confirmação explícita do humano antes. Task 1 termina
  no `db push --dry-run` — a aplicação real (`db push` sem dry-run) é feita
  pelo controlador da SDD (não por um subagente implementador) somente
  depois de mostrar o SQL exato ao usuário e receber autorização explícita.
  Nenhum subagente desta plan deve rodar `npx supabase db push` sem esse
  passo.
- Tasks 2 e 3 (guards no worker e no webhook) afetam o comportamento
  central de resposta automática da Helena — precisam ser testadas contra
  comportamento real de worker/webhook, não só typecheck. Um erro aqui
  significa a Helena parar de responder clientes que não deveriam estar
  bloqueados, ou continuar respondendo clientes que deveriam estar
  bloqueados — os dois lados do erro são igualmente ruins.
- Não alterar `takeover-timeout.ts` nem o timeout de 30 min do takeover
  temporário — os dois mecanismos são independentes, o novo não deve mexer
  no antigo.
- Não criar rota REST nova em `apps/api` para `wa_contacts` — toda escrita
  é direta via Supabase JS do cliente, mesmo padrão de
  `handleTakeoverToggle()` já existente.
- Não criar tabela de histórico/auditoria — só o estado atual
  (`ai_disabled`, `ai_disabled_at`, `ai_disabled_by`).
- Sem diálogo de confirmação ao **desativar** — só ao **reativar**. Essa
  assimetria é intencional (decisão explícita do usuário), não um esquecimento
  a "corrigir".
- Nenhum test runner existe em `apps/web`, `apps/api` ou `apps/worker` para
  este tipo de mudança (fato já confirmado nesta sessão para `apps/web`; os
  outros dois não têm suite alguma que cubra este fluxo) — verificação é
  `pnpm typecheck` em cada pacote afetado, mais teste manual ao vivo contra
  dados reais (com reversão segura e confirmada), não testes automatizados.

---

### Task 1: Migration — colunas novas em `wa_contacts`

**Files:**
- Create: `supabase/migrations/00021_wa_contacts_ai_disabled.sql`

**Interfaces:**
- Produces: três colunas novas em `wa_contacts` —
  `ai_disabled boolean NOT NULL DEFAULT false`,
  `ai_disabled_at timestamptz` (nullable),
  `ai_disabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL`
  (nullable). Todas as tasks seguintes dependem dessas colunas existirem no
  banco real antes de poderem ser testadas de ponta a ponta (embora
  typecheck/código das tasks 2-6 não dependa disso, a verificação AO VIVO
  de cada uma depende).

- [ ] **Step 1: Criar o arquivo de migration**

```sql
ALTER TABLE wa_contacts
  ADD COLUMN ai_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_disabled_at timestamptz,
  ADD COLUMN ai_disabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
```

Salvar em `supabase/migrations/00021_wa_contacts_ai_disabled.sql` — o
número `00021` segue a sequência existente (a migration mais recente hoje é
`00020_conversation_qualifications.sql`).

- [ ] **Step 2: Checar o histórico de migrations contra o banco linkado**

Seguir o runbook em `docs/operations/deployment.md`:

```bash
export SUPABASE_ACCESS_TOKEN=...   # exportar só na sessão do shell, nunca gravar em arquivo
npx supabase migration list --linked
```

Confirmar que `00021_wa_contacts_ai_disabled.sql` aparece como pendente
(não aplicada) e que não há nenhuma migration anterior pendente/fora de
ordem — se houver, PARE e escale para o humano antes de continuar (não é
esperado neste ponto da sessão, mas o runbook exige essa checagem).

- [ ] **Step 3: Dry-run — mostrar exatamente o que seria aplicado**

```bash
npx supabase db push --dry-run
```

Ler a saída: deve mostrar exatamente o `ALTER TABLE wa_contacts ADD COLUMN
...` do Step 1, nada mais. Confirmar que não há `DROP`, `TRUNCATE`,
`DELETE` ou qualquer operação destrutiva — é impossível haver, já que a
migration só adiciona colunas, mas confirme mesmo assim (parte do runbook).

**PARE AQUI.** Este é o limite do que este task/subagente faz sozinho. A
aplicação real (`npx supabase db push`, sem `--dry-run`) só acontece depois
que o controlador da SDD mostra a saída do dry-run ao usuário e recebe
confirmação explícita — não é uma etapa "e então aplique", é uma etapa "e
então pare e peça".

- [ ] **Step 4: Commit do arquivo de migration**

```bash
git add supabase/migrations/00021_wa_contacts_ai_disabled.sql
git commit -m "feat(db): add ai_disabled columns to wa_contacts"
```

O commit do ARQUIVO de migration acontece normalmente (é só texto no
repositório, sem risco) — é a APLICAÇÃO no banco real que precisa da pausa
do Step 3.

---

### Task 2: Guard no worker — `process-message.ts`

**Files:**
- Modify: `apps/worker/src/workers/process-message.ts:70-75`

**Interfaces:**
- Consumes: `conversation.wa_contacts.ai_disabled` — já disponível sem
  mudar nenhuma query, porque `getConversationById`
  (`packages/database/src/queries/conversations.ts:34-42`) já faz
  `.select("*, wa_contacts(*), agents(name)")`.

- [ ] **Step 1: Adicionar a segunda condição do guard**

Local atual (linhas 70-75):

```ts
        // Check if still not in human takeover
        const conversation = await getConversationById(db, conversationId);
        if (conversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} is in human takeover, skipping`);
          return;
        }
```

Vira:

```ts
        // Check if still not in human takeover
        const conversation = await getConversationById(db, conversationId);
        if (conversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} is in human takeover, skipping`);
          return;
        }
        if (conversation.wa_contacts?.ai_disabled) {
          console.log(`Conversation ${conversationId} contact has AI permanently disabled, skipping`);
          return;
        }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter worker typecheck`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/workers/process-message.ts
git commit -m "feat(worker): skip AI processing for contacts with ai_disabled"
```

Verificação ao vivo deste guard específico acontece na Task 7 (depende das
colunas já existirem no banco real, aplicadas na Task 1).

---

### Task 3: Guard no webhook — `evolution.ts`

**Files:**
- Modify: `apps/api/src/routes/webhooks/evolution.ts:174-177`

**Interfaces:**
- Consumes: `contact.ai_disabled` — já disponível sem mudar nenhuma query,
  porque `contact` vem de `ensureConversation()` →
  `upsertContact()` (`packages/database/src/queries/contacts.ts:20-34`),
  que termina em `.select().single()` (sem argumentos = `*`).

- [ ] **Step 1: Adicionar a segunda condição do guard de enfileiramento**

Local atual (linhas 174-177):

```ts
      // If human takeover is active, don't enqueue for LLM processing
      if (conversation.is_human_takeover) {
        return reply.status(200).send({ ok: true, skipped: "human_takeover" });
      }
```

Vira:

```ts
      // If human takeover is active, don't enqueue for LLM processing
      if (conversation.is_human_takeover) {
        return reply.status(200).send({ ok: true, skipped: "human_takeover" });
      }
      if (contact.ai_disabled) {
        return reply.status(200).send({ ok: true, skipped: "ai_disabled" });
      }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter api typecheck`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/webhooks/evolution.ts
git commit -m "feat(api): skip enqueueing messages for contacts with ai_disabled"
```

Verificação ao vivo deste guard específico acontece na Task 7.

---

### Task 4: UI do cabeçalho — gatilho "Desativar IA permanentemente"

**Files:**
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`
- Modify: `apps/web/src/components/inbox/chat-header.tsx`

**Interfaces:**
- Produces: `handleDisableAi` em `chat-panel.tsx`, passado como prop
  `onDisableAi: () => void` para `ChatHeader` — Task 5 consome esse mesmo
  prop para decidir se mostra o menu `⋮` ou o botão "Reativar IA".
- Produces: `ChatHeaderProps.conversation.wa_contacts` ganha o campo
  `ai_disabled: boolean` — Task 5 consome esse campo para a renderização
  condicional.

- [ ] **Step 1: Incluir `ai_disabled` na query de `fetchConversation`**

Em `chat-panel.tsx`, local atual:

```tsx
  const fetchConversation = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversations")
      .select("*, wa_contacts(id, phone, name), agents(name)")
      .eq("id", conversationId)
      .single();
    setConversation(data);
  }, [conversationId]);
```

Vira:

```tsx
  const fetchConversation = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversations")
      .select("*, wa_contacts(id, phone, name, ai_disabled), agents(name)")
      .eq("id", conversationId)
      .single();
    setConversation(data);
  }, [conversationId]);
```

- [ ] **Step 2: Adicionar `handleDisableAi` em `chat-panel.tsx`**

Logo depois de `handleTakeoverToggle` (linhas 103-118 hoje):

```tsx
  const handleDisableAi = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    await supabase
      .from("wa_contacts")
      .update({
        ai_disabled: true,
        ai_disabled_at: new Date().toISOString(),
        ai_disabled_by: user?.id,
      })
      .eq("id", conversation.wa_contacts.id);

    await supabase
      .from("conversations")
      .update({
        is_human_takeover: true,
        human_takeover_at: new Date().toISOString(),
        assigned_to: user?.id,
      })
      .eq("id", conversationId);

    fetchConversation();
  };
```

- [ ] **Step 3: Passar o novo prop pro `ChatHeader`**

```tsx
          <ChatHeader
            conversation={conversation}
            onStatusChange={handleStatusChange}
            onTakeoverToggle={handleTakeoverToggle}
            onDisableAi={handleDisableAi}
            onUpdate={fetchConversation}
            onOpenDetails={() => setDetailsOpen(true)}
            onClose={() => router.push("/inbox")}
          />
```

- [ ] **Step 4: Atualizar `ChatHeaderProps` e imports em `chat-header.tsx`**

Import atual:

```tsx
import { UserCheck, Bot, Info, X, ListChecks } from "lucide-react";
```

Vira:

```tsx
import { UserCheck, Bot, Info, X, ListChecks, MoreVertical } from "lucide-react";
```

Adicionar logo abaixo dos imports existentes:

```tsx
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
```

`ChatHeaderProps` atual:

```tsx
interface ChatHeaderProps {
  conversation: {
    id: string;
    organization_id: string;
    assigned_to: string | null;
    status: ConversationStatus;
    is_human_takeover: boolean;
    wa_contacts: { id: string; phone: string; name: string | null } | null;
    agents?: { name: string } | null;
  };
  onStatusChange: (status: string) => void;
  onTakeoverToggle: () => void;
  onUpdate: () => void;
  onOpenDetails: () => void;
  onClose: () => void;
}
```

Vira:

```tsx
interface ChatHeaderProps {
  conversation: {
    id: string;
    organization_id: string;
    assigned_to: string | null;
    status: ConversationStatus;
    is_human_takeover: boolean;
    wa_contacts: { id: string; phone: string; name: string | null; ai_disabled: boolean } | null;
    agents?: { name: string } | null;
  };
  onStatusChange: (status: string) => void;
  onTakeoverToggle: () => void;
  onDisableAi: () => void;
  onUpdate: () => void;
  onOpenDetails: () => void;
  onClose: () => void;
}
```

Destructuring da função (linhas 38-45 hoje) ganha `onDisableAi`:

```tsx
export function ChatHeader({
  conversation,
  onStatusChange,
  onTakeoverToggle,
  onDisableAi,
  onUpdate,
  onOpenDetails,
  onClose,
}: ChatHeaderProps) {
```

- [ ] **Step 5: Adicionar o menu `⋮` depois do botão de takeover**

Logo depois do `</Button>` que fecha o botão "Assumir Conversa"/"Devolver ao
Agente" (linha 96 hoje) e antes do bloco `{conversation.wa_contacts && (
<TaskDialog ...`, adicionar:

```tsx
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={onDisableAi}>
              Desativar IA permanentemente
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
```

Este é um estado intermediário deliberado: o menu aparece sempre por
enquanto, mesmo se a IA já estiver desativada — a Task 5 adiciona a
renderização condicional que esconde esse menu (e o botão de takeover
temporário) quando `ai_disabled` já é `true`.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: sem erros.

- [ ] **Step 7: Verificação ao vivo (parcial — sem banco migrado ainda)**

Como a Task 1 ainda não aplicou a migration no banco real neste ponto do
plano (a aplicação real só acontece depois da Task 1 estar totalmente
concluída, incluindo a pausa para confirmação), esta verificação é
estrutural: confirmar visualmente no navegador (dev server) que o botão
`⋮` aparece no cabeçalho do chat, abre o menu, e mostra "Desativar IA
permanentemente" em vermelho — sem necessariamente clicar (clicar
escreveria em colunas que ainda não existem no banco e falharia com erro
de coluna inexistente, o que é esperado e não é um bug desta task). A
verificação funcional completa (clicar e confirmar o efeito) acontece na
Task 7, depois que a Task 1 aplicar a migration de verdade.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/inbox/chat-panel.tsx apps/web/src/components/inbox/chat-header.tsx
git commit -m "feat(web): add a trigger to permanently disable the AI for a contact"
```

---

### Task 5: UI do cabeçalho — estado desativado, reativar, e correção do aviso

**Files:**
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`
- Modify: `apps/web/src/components/inbox/chat-header.tsx`

**Interfaces:**
- Consumes: `onDisableAi`, `conversation.wa_contacts.ai_disabled` (Task 4).
- Produces: `handleReenableAi` em `chat-panel.tsx`, passado como prop
  `onReenableAi: () => void` para `ChatHeader`.

- [ ] **Step 1: Adicionar `handleReenableAi` em `chat-panel.tsx`**

Logo depois de `handleDisableAi` (adicionado na Task 4):

```tsx
  const handleReenableAi = async () => {
    if (!confirm("Reativar a IA para este contato?")) return;
    const supabase = createClient();

    await supabase
      .from("wa_contacts")
      .update({ ai_disabled: false, ai_disabled_at: null, ai_disabled_by: null })
      .eq("id", conversation.wa_contacts.id);

    fetchConversation();
  };
```

- [ ] **Step 2: Passar o novo prop e corrigir o aviso "O agente está atendendo"**

Prop novo no `<ChatHeader>`:

```tsx
          <ChatHeader
            conversation={conversation}
            onStatusChange={handleStatusChange}
            onTakeoverToggle={handleTakeoverToggle}
            onDisableAi={handleDisableAi}
            onReenableAi={handleReenableAi}
            onUpdate={fetchConversation}
            onOpenDetails={() => setDetailsOpen(true)}
            onClose={() => router.push("/inbox")}
          />
```

Barra de aviso (linhas 175-179 hoje):

```tsx
          {conversation && !conversation.is_human_takeover && (
            <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
              O agente está atendendo. Enviar uma mensagem atribui a conversa a você e pausa o agente e as automações.
            </div>
          )}
```

Vira:

```tsx
          {conversation && !conversation.is_human_takeover && !conversation.wa_contacts?.ai_disabled && (
            <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
              O agente está atendendo. Enviar uma mensagem atribui a conversa a você e pausa o agente e as automações.
            </div>
          )}
```

- [ ] **Step 3: Adicionar `onReenableAi` a `ChatHeaderProps` e à assinatura da função**

```tsx
  onDisableAi: () => void;
  onReenableAi: () => void;
```

```tsx
export function ChatHeader({
  conversation,
  onStatusChange,
  onTakeoverToggle,
  onDisableAi,
  onReenableAi,
  onUpdate,
  onOpenDetails,
  onClose,
}: ChatHeaderProps) {
```

- [ ] **Step 4: Envolver o botão de takeover + menu `⋮` na renderização condicional**

O bloco adicionado/modificado na Task 4 (botão "Assumir Conversa"/"Devolver
ao Agente" + `DropdownMenu`) vira:

```tsx
        {conversation.wa_contacts?.ai_disabled ? (
          <Button
            variant="tonal"
            size="sm"
            className="rounded-full font-semibold"
            onClick={onReenableAi}
          >
            <Bot className="mr-1.5 h-3.5 w-3.5" />
            Reativar IA
          </Button>
        ) : (
          <>
            <Button
              variant={conversation.is_human_takeover ? "tonal" : "default"}
              size="sm"
              className="rounded-full font-semibold"
              onClick={onTakeoverToggle}
            >
              {conversation.is_human_takeover ? (
                <>
                  <Bot className="mr-1.5 h-3.5 w-3.5" />
                  Devolver ao Agente
                </>
              ) : (
                <>
                  <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                  Assumir Conversa
                </>
              )}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
                <MoreVertical className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onClick={onDisableAi}>
                  Desativar IA permanentemente
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/inbox/chat-panel.tsx apps/web/src/components/inbox/chat-header.tsx
git commit -m "feat(web): hide temporary takeover controls and add reactivate when AI is permanently disabled"
```

Verificação ao vivo completa (clicar de verdade, ver o estado mudar) fica
para a Task 7, depois que a Task 1 aplicar a migration real.

---

### Task 6: Badge "IA desativada" na lista de conversas

**Files:**
- Modify: `apps/web/src/app/(dashboard)/inbox/page.tsx:49`
- Modify: `apps/web/src/components/inbox/conversation-list.tsx`

**Interfaces:**
- Produces: `ConversationItem.wa_contacts` ganha `ai_disabled: boolean`.

- [ ] **Step 1: Selecionar `ai_disabled` na query da lista**

Em `apps/web/src/app/(dashboard)/inbox/page.tsx`, linha 49:

```tsx
      .select("*, wa_contacts(phone, name), agents(name), messages(content, created_at)")
```

Vira:

```tsx
      .select("*, wa_contacts(phone, name, ai_disabled), agents(name), messages(content, created_at)")
```

- [ ] **Step 2: Atualizar o tipo `ConversationItem`**

Em `apps/web/src/components/inbox/conversation-list.tsx`, tipo atual:

```tsx
  wa_contacts: {
    phone: string;
    name: string | null;
  };
```

Vira:

```tsx
  wa_contacts: {
    phone: string;
    name: string | null;
    ai_disabled: boolean;
  };
```

- [ ] **Step 3: Adicionar o branch em `getConversationTags`**

Função atual (linhas 39-53 hoje):

```tsx
function getConversationTags(
  conv: ConversationItem
): Array<{ label: string; kind: "badge"; variant: "tonal" | "destructive" } | { label: string; kind: "text" }> {
  const tags: Array<{ label: string; kind: "badge"; variant: "tonal" | "destructive" } | { label: string; kind: "text" }> = [];
  if (conv.status === "open" || conv.status === "waiting") {
    tags.push({ label: "Em andamento", kind: "badge", variant: "tonal" });
  }
  if (conv.is_human_takeover) {
    tags.push({ label: "Atenção Humana", kind: "badge", variant: "destructive" });
    if (!conv.assigned_to) {
      tags.push({ label: "Disponível para assumir", kind: "text" });
    }
  }
  return tags;
}
```

Vira:

```tsx
function getConversationTags(
  conv: ConversationItem
): Array<{ label: string; kind: "badge"; variant: "tonal" | "destructive" } | { label: string; kind: "text" }> {
  const tags: Array<{ label: string; kind: "badge"; variant: "tonal" | "destructive" } | { label: string; kind: "text" }> = [];
  if (conv.status === "open" || conv.status === "waiting") {
    tags.push({ label: "Em andamento", kind: "badge", variant: "tonal" });
  }
  if (conv.wa_contacts.ai_disabled) {
    tags.push({ label: "IA desativada", kind: "badge", variant: "destructive" });
  }
  if (conv.is_human_takeover) {
    tags.push({ label: "Atenção Humana", kind: "badge", variant: "destructive" });
    if (!conv.assigned_to) {
      tags.push({ label: "Disponível para assumir", kind: "text" });
    }
  }
  return tags;
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: sem erros.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(dashboard)/inbox/page.tsx" apps/web/src/components/inbox/conversation-list.tsx
git commit -m "feat(web): show an AI-disabled badge in the inbox conversation list"
```

Verificação ao vivo completa fica para a Task 7.

---

### Task 7: Validação final — migration real + os 5 cenários da spec

**Files:** nenhum esperado (só verificação; se algo real for encontrado,
corrigir no arquivo correspondente e anotar aqui antes de re-verificar).

**Este task é o único ponto do plano onde a migration é de fato aplicada
no banco real — e só depois de confirmação explícita do humano.**

- [ ] **Step 1: Mostrar o dry-run ao humano e pedir confirmação**

Reapresentar a saída do `npx supabase db push --dry-run` (Task 1, Step 3)
ao usuário, junto com o SQL exato que seria aplicado. Só prosseguir para o
Step 2 depois de confirmação explícita — esta é a barreira descrita nas
Global Constraints, não uma formalidade.

- [ ] **Step 2: Aplicar a migration de verdade**

```bash
npx supabase db push
```

- [ ] **Step 3: Confirmar via `information_schema.columns`**

Rodar contra o banco linkado (via MCP do Supabase ou `psql`, conforme
disponível na sessão):

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'wa_contacts'
  and column_name in ('ai_disabled', 'ai_disabled_at', 'ai_disabled_by');
```

Esperado: as 3 colunas, com os tipos/nullability exatos da Task 1.

- [ ] **Step 4: Typecheck final em todos os pacotes tocados**

```bash
pnpm --filter web typecheck
pnpm --filter api typecheck
pnpm --filter worker typecheck
```

Expected: sem erros nos três.

- [ ] **Step 5: Cenário 1 — desativar a IA numa conversa aberta**

Usando um contato/conversa real (ou um contato de teste criado para este
fim), abrir o chat, clicar `⋮` → "Desativar IA permanentemente". Confirmar:
`wa_contacts.ai_disabled = true`, `ai_disabled_at`/`ai_disabled_by`
preenchidos; a conversa atual virou takeover (`is_human_takeover = true`,
`assigned_to` = você); o botão de takeover temporário sumiu, só resta
"Reativar IA"; badge "IA desativada" aparece na lista.

- [ ] **Step 6: Cenário 2 — mandar uma mensagem real do contato e confirmar bloqueio**

Com o contato do Cenário 1 ainda com `ai_disabled = true`, mandar (ou
simular via webhook/worker, o que for mais seguro e realista disponível)
uma mensagem nova desse número. Confirmar nos logs do worker/webhook que a
mensagem foi processada mas a IA NÃO respondeu — o guard novo
(`ai_disabled`) deve ter pulado o processamento antes mesmo de checar
`is_human_takeover`.

- [ ] **Step 7: Cenário 3 — aviso "O agente está atendendo" não reaparece após o takeover expirar**

Sem esperar 30 minutos reais: atualizar `human_takeover_at` diretamente no
banco para um valor antigo o suficiente para o
`takeover-timeout.ts` considerar expirado (ou rodar a lógica de expiração
manualmente contra essa linha), mantendo `ai_disabled = true`. Recarregar o
chat e confirmar que a barra "O agente está atendendo..." continua
**ausente**, mesmo com `is_human_takeover` agora `false` — é exatamente o
bug que a correção do Step 2 da Task 5 evita.

- [ ] **Step 8: Cenário 4 — reativar com confirmação**

Clicar "Reativar IA". Confirmar que aparece o diálogo nativo
("Reativar a IA para este contato?"). Cancelar uma vez e confirmar que nada
mudou no banco. Repetir e confirmar desta vez: as 3 colunas voltam a
`false`/`null`/`null`; o botão de takeover temporário volta a aparecer
(mostrando "Devolver ao Agente" se `is_human_takeover` ainda for `true` da
etapa anterior, ou "Assumir Conversa" se já tiver expirado); uma nova
mensagem desse contato volta a acionar a Helena normalmente (assumindo que
`is_human_takeover` daquela conversa específica já não esteja mais ativo).

- [ ] **Step 9: Cenário 5 — badge aparece em qualquer conversa do contato, não só na que estava aberta**

Repetir o Cenário 1 num contato que tenha (ou que você crie) mais de uma
conversa registrada. Confirmar que o badge "IA desativada" aparece nas
DUAS conversas na lista, não só na que estava aberta quando você clicou
"Desativar IA permanentemente" — comprova que o flag é por contato
(`wa_contacts`), não por conversa.

- [ ] **Step 10: Caso de controle — nenhuma mudança de comportamento para `ai_disabled = false`**

Escolher um contato qualquer sem `ai_disabled` nunca tocado (padrão
`false`). Confirmar que: nenhum badge novo aparece; o botão de takeover
temporário se comporta exatamente como antes (Assumir/Devolver, expira em
30 min); a barra "O agente está atendendo" aparece/some exatamente como
antes; a Helena responde normalmente. Este é o teste mais importante do
plano inteiro — garante que a feature nova não regrediu o comportamento
padrão de todos os outros contatos.

- [ ] **Step 11: Reverter qualquer dado de teste**

Para qualquer contato real usado nos passos acima (não um contato de teste
descartável criado só para isso), reverter `ai_disabled` para `false` e
`ai_disabled_at`/`ai_disabled_by` para `null`, e devolver `is_human_takeover`/
`assigned_to` da conversa ao estado original. Confirmar a reversão com uma
leitura fresca do banco (não cache do navegador) — mesmo padrão de reversão
segura já usado nesta sessão para outras features.

- [ ] **Step 12: Relatório**

Resumir para o humano: quais dos 5 cenários (mais o caso de controle) foram
verificados contra dado real vs. dado de teste descartável, qualquer desvio
encontrado da spec (corrigido nesta task ou anotado como gap residual), e
confirmação explícita de que nenhum contato real ficou com a IA
permanentemente desativada por engano ao final da validação.
