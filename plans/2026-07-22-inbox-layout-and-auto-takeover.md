# Inbox Layout + Auto Human-Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI agent stop responding automatically the moment a human sends a manual reply through the inbox, and restructure the inbox's conversation list and chat panel to match the reference product's layout (filter tabs, header-level takeover controls, a truthful notice bar) — while keeping our own blueprint visual identity.

**Architecture:** One small backend change (`apps/api/src/routes/messages/send.ts` flips `is_human_takeover` on manual send, mirroring the existing manual-toggle logic). Three frontend changes: filter tabs replace the single status dropdown in the conversation list, the existing "Humano" row badge is relabeled/restyled, and the chat panel's header/side-panel split is reorganized (status + takeover button move to a new header component; the "assign to teammate" control is extracted into its own small component and stays in the side panel).

**Tech Stack:** Fastify + Supabase (`@aula-agente/database`), Next.js client components, no new backend endpoints.

## Global Constraints

- Keep the existing blueprint visual identity (colors, type, radius) — this is a structural/layout change, not a re-skin.
- The "Atenção" filter tab uses `is_human_takeover === true` (not the Início page's stricter "and unanswered" rule) — deliberate simplification for a browsing list, not a bug.
- Don't duplicate the takeover-toggle network call in two places — the toggle button's handler lives in one place (`chat-panel.tsx`) and is passed down as a prop.
- No new backend endpoints for the frontend tasks — filtering happens client-side over data already fetched.

---

### Task 1: Auto human-takeover on manual send

**Files:**
- Modify: `apps/api/src/routes/messages/send.ts`

**Interfaces:**
- Consumes: `updateConversation(client, id, updates: Partial<Conversation>)` — already exported from `@aula-agente/database` (used elsewhere, e.g. `apps/web/src/components/inbox/side-panel.tsx` calls the equivalent Supabase update directly; the backend route imports the query-package version).
- Produces: no new exports — this task only changes route behavior.

- [ ] **Step 1: Add the takeover flip after the message is saved**

Replace the full contents of `apps/api/src/routes/messages/send.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import { sendMessageSchema } from "@aula-agente/shared";
import { getAdminClient, getConversationById, updateConversation } from "@aula-agente/database";
import { getInstanceById } from "@aula-agente/database";
import { authMiddleware, requireOrg } from "../../middleware/auth.js";
import { saveMessage } from "../../services/message.service.js";
import { enqueueSendMessage } from "../../lib/queue.js";

export default async function messageSendRoutes(app: FastifyInstance) {
  app.post("/messages/send", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      const parseResult = sendMessageSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const { conversation_id, content } = parseResult.data;
      const db = getAdminClient();

      // Get conversation
      const conversation = await getConversationById(db, conversation_id);
      if (!conversation) {
        return reply.status(404).send({ error: "Conversation not found" });
      }

      // Check user has access to this org
      const membership = request.user.memberships.find(
        (m) => m.organization_id === conversation.organization_id
      );
      if (!membership) {
        return reply.status(403).send({ error: "Access denied" });
      }

      // Save human agent message
      const message = await saveMessage({
        conversationId: conversation_id,
        organizationId: conversation.organization_id,
        evolutionMessageId: null,
        role: "human_agent",
        content,
      });

      if (!message) {
        return reply.status(500).send({ error: "Failed to save message" });
      }

      // A human replying manually takes the conversation over — the AI
      // agent stops responding until someone explicitly hands it back
      // (the existing "Devolver ao Agente" toggle). Don't touch takeover
      // state if a human already owns this conversation — the first
      // responder keeps ownership.
      if (!conversation.is_human_takeover) {
        await updateConversation(db, conversation_id, {
          is_human_takeover: true,
          human_takeover_at: new Date().toISOString(),
          assigned_to: request.user.id,
        });
      }

      // Get instance for sending
      const instance = await getInstanceById(db, conversation.evolution_instance_id);

      // Get contact phone from conversation
      const contact = conversation.wa_contacts;

      // Enqueue send
      await enqueueSendMessage({
        conversationId: conversation_id,
        messageId: message.id,
        instanceId: instance.id,
        phone: contact.phone,
        content,
        organizationId: conversation.organization_id,
      });

      return reply.status(200).send({ ok: true, messageId: message.id });
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @aula-agente/api exec tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/messages/send.ts
git commit -m "feat: auto-assign human takeover when a human sends a manual reply"
```

- [ ] **Step 4: Manually verify against the running dev API**

This route has no existing test harness in this repo (route handlers with DB/queue side effects are verified live here, e.g. the group-message webhook filter earlier in this project's history — not unit tested). With the dev API and web servers running:

1. In the browser, open the Inbox and pick a conversation currently **not** in human takeover (no "Humano" badge in the list, and the side panel's "Assumir Conversa" button — not yet moved by Task 3 — shows the non-active state).
2. Send any message through the composer.
3. Confirm in the running API's logs (or the Supabase dashboard) that the conversation's `is_human_takeover` is now `true`, `human_takeover_at` is set, and `assigned_to` equals your own user id. You can check this with:
   ```bash
   curl -s "${SUPABASE_URL}/rest/v1/conversations?id=eq.<conversation_id>&select=is_human_takeover,human_takeover_at,assigned_to" \
     -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
     -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
   ```
   (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` from the repo's root `.env`.)
4. Send a second message on the same conversation and confirm `assigned_to` does **not** change to a different value (guards the "first responder keeps ownership" rule) — trivial to check by re-running the same curl command.

---

### Task 2: Inbox filter tabs + row badge relabel

**Files:**
- Modify: `apps/web/src/app/(dashboard)/inbox/page.tsx`
- Modify: `apps/web/src/components/inbox/conversation-list.tsx`

**Interfaces:**
- Consumes: `cn` from `@/lib/utils` (already used the same way in `apps/web/src/components/layout/app-sidebar.tsx`).
- Produces: no new exports — both changes are self-contained within existing components.

- [ ] **Step 1: Replace the status dropdown with filter tabs**

Replace the full contents of `apps/web/src/app/(dashboard)/inbox/page.tsx` with:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { ChatPanel } from "@/components/inbox/chat-panel";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

type FilterTab = "all" | "mine" | "agent" | "others" | "attention";

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "mine", label: "Minhas" },
  { id: "agent", label: "Agente" },
  { id: "others", label: "Outros" },
  { id: "attention", label: "Atenção" },
];

export default function InboxPage() {
  const { currentOrg } = useOrganization();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState<string | null>(null);

  const selectedId = searchParams.get("id");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const fetchConversations = useCallback(async () => {
    if (!currentOrg) return;
    const supabase = createClient();

    const { data } = await supabase
      .from("conversations")
      .select("*, wa_contacts(phone, name), agents(name)")
      .eq("organization_id", currentOrg.id)
      .order("last_message_at", { ascending: false });

    setConversations(data || []);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Realtime updates for conversations
  useRealtime({
    table: "conversations",
    filter: currentOrg ? `organization_id=eq.${currentOrg.id}` : undefined,
    onInsert: () => fetchConversations(),
    onUpdate: () => fetchConversations(),
    enabled: !!currentOrg,
  });

  const handleSelect = (id: string) => {
    router.push(`/inbox?id=${id}`);
  };

  const matchesTab = (c: any) => {
    switch (filterTab) {
      case "mine":
        return c.assigned_to === userId;
      case "agent":
        return !c.is_human_takeover;
      case "others":
        return c.assigned_to !== null && c.assigned_to !== userId;
      case "attention":
        return c.is_human_takeover === true;
      default:
        return true;
    }
  };

  const filtered = conversations.filter((c) => {
    if (!matchesTab(c)) return false;
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      c.wa_contacts?.name?.toLowerCase().includes(searchLower) ||
      c.wa_contacts?.phone?.includes(search)
    );
  });

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-0 -m-6">
      {/* Sidebar: Conversation List */}
      <div className="flex w-80 flex-col border-r">
        <div className="space-y-2 border-b p-3">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilterTab(tab.id)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  filterTab === tab.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ConversationList
            conversations={filtered}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
        </div>
      </div>

      {/* Main: Chat Panel */}
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        {selectedId ? (
          <ChatPanel conversationId={selectedId} />
        ) : (
          <p>Selecione uma conversa</p>
        )}
      </div>
    </div>
  );
}
```

This removes the four-value status `Select` (Todos/Abertos/Aguardando/Resolvidos/Fechados) entirely — it's replaced by the five semantic tabs above, per the spec.

- [ ] **Step 2: Relabel the existing human-takeover row badge**

In `apps/web/src/components/inbox/conversation-list.tsx`, find:

```tsx
              {conv.is_human_takeover && (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">Humano</Badge>
              )}
```

Replace with:

```tsx
              {conv.is_human_takeover && (
                <Badge variant="destructive" className="h-4 px-1 text-[10px]">Atenção Humana</Badge>
              )}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aula-agente/web exec tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 4: Manually verify in the browser**

With the web dev server running, open `/inbox`. Confirm:
- Five pill tabs (Todas/Minhas/Agente/Outros/Atenção) render above the search box, replacing the old dropdown.
- Clicking each tab filters the list; "Atenção" shows only conversations with the "Atenção Humana" badge (rust/destructive colored, not the old gray outline "Humano" badge).
- "Minhas" shows conversations assigned to you (if any exist) — you can create one by taking over a conversation via the side panel's existing "Assumir Conversa" button first, then check it appears under "Minhas".

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/inbox/page.tsx apps/web/src/components/inbox/conversation-list.tsx
git commit -m "feat: replace inbox status dropdown with filter tabs, relabel takeover badge"
```

---

### Task 3: Chat header restructure + notice bar

**Files:**
- Create: `apps/web/src/components/inbox/chat-header.tsx`
- Create: `apps/web/src/components/inbox/assign-select.tsx`
- Delete: `apps/web/src/components/inbox/takeover-bar.tsx`
- Modify: `apps/web/src/components/inbox/side-panel.tsx`
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`

**Interfaces:**
- Produces: `ChatHeader({ conversation, onStatusChange, onTakeoverToggle })` — a client component rendering contact name/phone/agent on the left and the status `Select` + takeover toggle `Button` on the right.
- Produces: `AssignSelect({ conversationId, assignedTo, organizationId, onUpdate })` — the "assign to teammate" `Select`, extracted from the old `TakeoverBar` with its toggle button removed.
- Consumes: `ConversationStatus` type from `@aula-agente/shared` (already used in the current `side-panel.tsx`).

- [ ] **Step 1: Create the assign-to-teammate component**

Create `apps/web/src/components/inbox/assign-select.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AssignSelectProps {
  conversationId: string;
  assignedTo: string | null;
  organizationId: string;
  onUpdate: () => void;
}

export function AssignSelect({ conversationId, assignedTo, organizationId, onUpdate }: AssignSelectProps) {
  const [members, setMembers] = useState<Array<{ user_id: string; role: string }>>([]);

  useEffect(() => {
    const fetchMembers = async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("organization_members")
        .select("user_id, role")
        .eq("organization_id", organizationId);
      setMembers(data || []);
    };
    fetchMembers();
  }, [organizationId]);

  const handleAssign = async (userId: string) => {
    const supabase = createClient();
    await supabase
      .from("conversations")
      .update({ assigned_to: userId === "none" ? null : userId })
      .eq("id", conversationId);
    onUpdate();
  };

  return (
    <Select value={assignedTo || "none"} onValueChange={(v) => v && handleAssign(v)}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Atribuir a..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Ninguem</SelectItem>
        {members.map((m) => (
          <SelectItem key={m.user_id} value={m.user_id}>
            {m.user_id.slice(0, 8)}... ({m.role})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 2: Create the chat header component**

Create `apps/web/src/components/inbox/chat-header.tsx`:

```tsx
"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { UserCheck, Bot } from "lucide-react";
import type { ConversationStatus } from "@aula-agente/shared";

interface ChatHeaderProps {
  conversation: {
    status: ConversationStatus;
    is_human_takeover: boolean;
    wa_contacts: { phone: string; name: string | null };
    agents?: { name: string } | null;
  };
  onStatusChange: (status: string) => void;
  onTakeoverToggle: () => void;
}

export function ChatHeader({ conversation, onStatusChange, onTakeoverToggle }: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
      <div>
        <p className="font-medium">
          {conversation.wa_contacts.name || conversation.wa_contacts.phone}
        </p>
        <p className="text-xs text-muted-foreground">{conversation.wa_contacts.phone}</p>
        {conversation.agents?.name && (
          <p className="text-xs text-muted-foreground">Agente: {conversation.agents.name}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Select value={conversation.status} onValueChange={(v) => v && onStatusChange(v)}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Aberto</SelectItem>
            <SelectItem value="waiting">Aguardando</SelectItem>
            <SelectItem value="resolved">Resolvido</SelectItem>
            <SelectItem value="closed">Fechado</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant={conversation.is_human_takeover ? "default" : "outline"}
          size="sm"
          onClick={onTakeoverToggle}
        >
          {conversation.is_human_takeover ? (
            <>
              <Bot className="mr-2 h-4 w-4" />
              Devolver ao Agente
            </>
          ) : (
            <>
              <UserCheck className="mr-2 h-4 w-4" />
              Assumir Conversa
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Delete the old takeover-bar component**

```bash
rm apps/web/src/components/inbox/takeover-bar.tsx
```

- [ ] **Step 4: Slim down the side panel**

Replace the full contents of `apps/web/src/components/inbox/side-panel.tsx` with:

```tsx
"use client";

import { AssignSelect } from "./assign-select";
import { TagsInput } from "./tags-input";
import { NotesPanel } from "./notes-panel";
import { Separator } from "@/components/ui/separator";
import type { ConversationStatus } from "@aula-agente/shared";

interface SidePanelProps {
  conversation: {
    id: string;
    organization_id: string;
    status: ConversationStatus;
    is_human_takeover: boolean;
    assigned_to: string | null;
    tags: string[];
    wa_contacts: { phone: string; name: string | null };
  };
  onUpdate: () => void;
}

export function SidePanel({ conversation, onUpdate }: SidePanelProps) {
  return (
    <div className="w-72 space-y-4 overflow-y-auto border-l p-4">
      {/* Contact Info */}
      <div>
        <h3 className="text-sm font-semibold">Contato</h3>
        <p className="text-sm">{conversation.wa_contacts.name || "Sem nome"}</p>
        <p className="text-xs text-muted-foreground">{conversation.wa_contacts.phone}</p>
      </div>

      <Separator />

      {/* Assignment */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Atribuido a</h3>
        <AssignSelect
          conversationId={conversation.id}
          assignedTo={conversation.assigned_to}
          organizationId={conversation.organization_id}
          onUpdate={onUpdate}
        />
      </div>

      <Separator />

      {/* Tags */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Tags</h3>
        <TagsInput
          conversationId={conversation.id}
          tags={conversation.tags}
          onUpdate={onUpdate}
        />
      </div>

      <Separator />

      {/* Notes */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Notas Internas</h3>
        <NotesPanel
          conversationId={conversation.id}
          organizationId={conversation.organization_id}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire the new header and notice bar into the chat panel**

Replace the full contents of `apps/web/src/components/inbox/chat-panel.tsx` with:

```tsx
"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { apiFetch } from "@/lib/api";
import { MessageBubble } from "./message-bubble";
import { ChatHeader } from "./chat-header";
import { SidePanel } from "./side-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send } from "lucide-react";
import type { Message } from "@aula-agente/shared";

interface ChatPanelProps {
  conversationId: string;
}

export function ChatPanel({ conversationId }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversation, setConversation] = useState<any>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchMessages = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    setMessages((data as Message[]) || []);
  }, [conversationId]);

  const fetchConversation = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversations")
      .select("*, wa_contacts(phone, name), agents(name)")
      .eq("id", conversationId)
      .single();
    setConversation(data);
  }, [conversationId]);

  useEffect(() => {
    fetchMessages();
    fetchConversation();
  }, [fetchMessages, fetchConversation]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Realtime messages
  useRealtime<Message>({
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`,
    onInsert: (newMsg) => {
      setMessages((prev) => [...prev, newMsg]);
    },
  });

  const handleStatusChange = async (status: string) => {
    const supabase = createClient();
    await supabase
      .from("conversations")
      .update({ status })
      .eq("id", conversationId);
    fetchConversation();
  };

  const handleTakeoverToggle = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const nextTakeover = !conversation?.is_human_takeover;

    await supabase
      .from("conversations")
      .update({
        is_human_takeover: nextTakeover,
        human_takeover_at: nextTakeover ? new Date().toISOString() : null,
        assigned_to: nextTakeover ? user?.id : null,
      })
      .eq("id", conversationId);

    fetchConversation();
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    setSending(true);

    try {
      await apiFetch("/messages/send", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          content: input.trim(),
        }),
      });
      setInput("");
      // Task 1's backend change may have just flipped is_human_takeover —
      // refetch so the header button and the notice bar below reflect it
      // immediately instead of waiting for the next realtime event.
      fetchConversation();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao enviar");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full w-full">
      <div className="flex flex-1 flex-col">
        {conversation && (
          <ChatHeader
            conversation={conversation}
            onStatusChange={handleStatusChange}
            onTakeoverToggle={handleTakeoverToggle}
          />
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Notice + Input */}
        <div className="border-t">
          {conversation && !conversation.is_human_takeover && (
            <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
              O agente está atendendo. Enviar uma mensagem atribui a conversa a você e pausa o agente e as automações.
            </div>
          )}
          <div className="flex gap-2 p-4">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Digite uma mensagem..."
              disabled={sending}
            />
            <Button onClick={handleSend} disabled={sending || !input.trim()} size="icon">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Side Panel */}
      {conversation && (
        <SidePanel conversation={conversation} onUpdate={fetchConversation} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @aula-agente/web exec tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 7: Manually verify in the browser**

With the web dev server running (and Task 1 already deployed to the API, since this notice bar's truthfulness depends on it):

1. Open a conversation **not** in human takeover. Confirm the header (not the side panel) shows name/phone/agent on the left and a status dropdown + "Assumir Conversa" button on the right.
2. Confirm the rust-tinted notice bar appears directly above the message input, with the exact copy: "O agente está atendendo. Enviar uma mensagem atribui a conversa a você e pausa o agente e as automações."
3. Send a message. Confirm: the notice bar disappears, the header button now reads "Devolver ao Agente", and the side panel's "Atribuido a" section (not the old "Atendimento" section) still works for reassigning to a teammate.
4. Click "Devolver ao Agente" in the header. Confirm the button flips back and the notice bar reappears.
5. Confirm the side panel no longer has a separate "Status" section (it moved to the header) and still has Contato, Atribuido a, Tags, and Notas Internas.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/inbox/chat-header.tsx apps/web/src/components/inbox/assign-select.tsx apps/web/src/components/inbox/side-panel.tsx apps/web/src/components/inbox/chat-panel.tsx
git rm apps/web/src/components/inbox/takeover-bar.tsx
git commit -m "feat: move takeover controls to chat header, add auto-takeover notice bar"
```

---

## Self-Review Notes

- **Spec coverage:** Part 1 (auto-takeover) → Task 1. Filter tabs → Task 2 Step 1. Row badge → Task 2 Step 2. Header restructure → Task 3 Steps 1-5. Notice bar → Task 3 Step 5. All covered.
- **Spec correction:** the design spec claimed the chat header "already shows" the agent name today — it doesn't (the current `chat-panel.tsx` header only renders name and phone). Task 3 Step 5's `fetchConversation` query adds `agents(name)` to the select (matching what `inbox/page.tsx` already fetches) so `ChatHeader` has real data to render.
- **Type consistency:** `ChatHeader`'s `conversation` prop shape (`status`, `is_human_takeover`, `wa_contacts`, `agents`) is a subset of what `chat-panel.tsx`'s `fetchConversation` now selects (`*, wa_contacts(phone, name), agents(name)`) — every field `ChatHeader` reads is present.
- **No placeholders:** every step has complete, runnable code; Task 1's manual verification step names the exact curl command and env vars (already used earlier in this project for the same kind of check).
