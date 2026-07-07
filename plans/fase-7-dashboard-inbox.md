# Fase 7: Dashboard — Inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar inbox completo: lista de conversas com filtros, chat em tempo real, takeover humano, atribuicao de conversas, notas internas, tags, e metricas.

**Architecture:** Lista de conversas e mensagens via Supabase SDK com RLS. Mensagens em tempo real via Supabase Realtime. Envio de mensagens pelo humano via API backend. Takeover e atribuicao via Supabase direto.

**Tech Stack:** Next.js 15, Supabase Realtime, shadcn/ui

**Depends on:** Fase 4 (layout, auth), Fase 2 (message send route)

---

### Task 1: Lista de Conversas

**Files:**
- Create: `apps/web/src/app/(dashboard)/inbox/page.tsx`
- Create: `apps/web/src/components/inbox/conversation-list.tsx`

- [ ] **Step 1: Criar conversation-list.tsx**

Criar `apps/web/src/components/inbox/conversation-list.tsx`:
```tsx
"use client";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { User, Bot } from "lucide-react";

interface ConversationItem {
  id: string;
  status: string;
  is_human_takeover: boolean;
  last_message_at: string;
  tags: string[];
  assigned_to: string | null;
  contacts: {
    phone: string;
    name: string | null;
  };
  agents: {
    name: string;
  };
}

interface ConversationListProps {
  conversations: ConversationItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {
  const statusColors: Record<string, string> = {
    open: "bg-green-500",
    waiting: "bg-yellow-500",
    resolved: "bg-blue-500",
    closed: "bg-gray-500",
  };

  return (
    <div className="flex flex-col">
      {conversations.map((conv) => (
        <button
          key={conv.id}
          onClick={() => onSelect(conv.id)}
          className={cn(
            "flex items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-accent/50",
            selectedId === conv.id && "bg-accent"
          )}
        >
          <Avatar className="h-10 w-10">
            <AvatarFallback>
              {conv.contacts.name?.[0]?.toUpperCase() || <User className="h-4 w-4" />}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 overflow-hidden">
            <div className="flex items-center justify-between">
              <p className="truncate text-sm font-medium">
                {conv.contacts.name || conv.contacts.phone}
              </p>
              <span className="text-xs text-muted-foreground">
                {new Date(conv.last_message_at).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className={cn("h-2 w-2 rounded-full", statusColors[conv.status])} />
              <span className="text-xs text-muted-foreground">{conv.agents.name}</span>
              {conv.is_human_takeover && (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">Humano</Badge>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Atualizar pagina do inbox**

Criar `apps/web/src/app/(dashboard)/inbox/page.tsx`:
```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

export default function InboxPage() {
  const { currentOrg } = useOrganization();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const selectedId = searchParams.get("id");

  const fetchConversations = useCallback(async () => {
    if (!currentOrg) return;
    const supabase = createClient();

    let query = supabase
      .from("conversations")
      .select("*, contacts(phone, name), agents(name)")
      .eq("organization_id", currentOrg.id)
      .order("last_message_at", { ascending: false });

    if (statusFilter !== "all") {
      query = query.eq("status", statusFilter);
    }

    const { data } = await query;
    setConversations(data || []);
    setLoading(false);
  }, [currentOrg, statusFilter]);

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

  const filtered = conversations.filter((c) => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      c.contacts?.name?.toLowerCase().includes(searchLower) ||
      c.contacts?.phone?.includes(search)
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
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Filtrar status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="open">Abertos</SelectItem>
              <SelectItem value="waiting">Aguardando</SelectItem>
              <SelectItem value="resolved">Resolvidos</SelectItem>
              <SelectItem value="closed">Fechados</SelectItem>
            </SelectContent>
          </Select>
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
          <ChatPanelLoader conversationId={selectedId} />
        ) : (
          <p>Selecione uma conversa</p>
        )}
      </div>
    </div>
  );
}

// Lazy load chat panel to avoid re-renders
function ChatPanelLoader({ conversationId }: { conversationId: string }) {
  const ChatPanel = require("@/components/inbox/chat-panel").ChatPanel;
  return <ChatPanel conversationId={conversationId} />;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/inbox/ apps/web/src/components/inbox/conversation-list.tsx
git commit -m "feat(web): add inbox conversation list with filters and realtime"
```

---

### Task 2: Chat Panel com Mensagens em Tempo Real

**Files:**
- Create: `apps/web/src/components/inbox/chat-panel.tsx`
- Create: `apps/web/src/components/inbox/message-bubble.tsx`

- [ ] **Step 1: Criar message-bubble.tsx**

Criar `apps/web/src/components/inbox/message-bubble.tsx`:
```tsx
import { cn } from "@/lib/utils";
import type { Message } from "@aula-agente/shared";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isContact = message.role === "contact";
  const isAgent = message.role === "agent";
  const isHuman = message.role === "human_agent";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="flex justify-center py-2">
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex", isContact ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[70%] rounded-lg px-3 py-2",
          isContact && "bg-muted",
          isAgent && "bg-primary text-primary-foreground",
          isHuman && "bg-blue-500 text-white"
        )}
      >
        {(isAgent || isHuman) && (
          <p className="mb-1 text-[10px] opacity-70">
            {isAgent ? "Agente" : "Atendente"}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        <p className={cn(
          "mt-1 text-right text-[10px]",
          isContact ? "text-muted-foreground" : "opacity-70"
        )}>
          {new Date(message.created_at).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Criar chat-panel.tsx**

Criar `apps/web/src/components/inbox/chat-panel.tsx`:
```tsx
"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { apiFetch } from "@/lib/api";
import { MessageBubble } from "./message-bubble";
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
      .select("*, contacts(phone, name)")
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
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="border-b px-4 py-3">
        <p className="font-medium">
          {conversation?.contacts?.name || conversation?.contacts?.phone || "Conversa"}
        </p>
        <p className="text-xs text-muted-foreground">
          {conversation?.contacts?.phone}
        </p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t p-4">
        <div className="flex gap-2">
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
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/inbox/
git commit -m "feat(web): add chat panel with realtime messages and send"
```

---

### Task 3: Takeover Bar + Atribuicao

**Files:**
- Create: `apps/web/src/components/inbox/takeover-bar.tsx`

- [ ] **Step 1: Criar takeover-bar.tsx**

Criar `apps/web/src/components/inbox/takeover-bar.tsx`:
```tsx
"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserCheck, Bot } from "lucide-react";

interface TakeoverBarProps {
  conversationId: string;
  isHumanTakeover: boolean;
  assignedTo: string | null;
  organizationId: string;
  onUpdate: () => void;
}

export function TakeoverBar({
  conversationId,
  isHumanTakeover,
  assignedTo,
  organizationId,
  onUpdate,
}: TakeoverBarProps) {
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

  const handleTakeover = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    await supabase
      .from("conversations")
      .update({
        is_human_takeover: !isHumanTakeover,
        human_takeover_at: !isHumanTakeover ? new Date().toISOString() : null,
        assigned_to: !isHumanTakeover ? user?.id : null,
      })
      .eq("id", conversationId);

    onUpdate();
  };

  const handleAssign = async (userId: string) => {
    const supabase = createClient();
    await supabase
      .from("conversations")
      .update({ assigned_to: userId === "none" ? null : userId })
      .eq("id", conversationId);
    onUpdate();
  };

  return (
    <div className="flex items-center gap-3 rounded-md border bg-muted/50 p-3">
      <Button
        variant={isHumanTakeover ? "default" : "outline"}
        size="sm"
        onClick={handleTakeover}
      >
        {isHumanTakeover ? (
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

      <Select value={assignedTo || "none"} onValueChange={handleAssign}>
        <SelectTrigger className="w-48">
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
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/inbox/takeover-bar.tsx
git commit -m "feat(web): add takeover bar with human takeover and assignment"
```

---

### Task 4: Painel Lateral — Notas + Tags

**Files:**
- Create: `apps/web/src/components/inbox/side-panel.tsx`
- Create: `apps/web/src/components/inbox/notes-panel.tsx`
- Create: `apps/web/src/components/inbox/tags-input.tsx`

- [ ] **Step 1: Criar tags-input.tsx**

Criar `apps/web/src/components/inbox/tags-input.tsx`:
```tsx
"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";

interface TagsInputProps {
  conversationId: string;
  tags: string[];
  onUpdate: () => void;
}

export function TagsInput({ conversationId, tags, onUpdate }: TagsInputProps) {
  const [input, setInput] = useState("");

  const handleAdd = async () => {
    if (!input.trim() || tags.includes(input.trim())) return;
    const newTags = [...tags, input.trim()];
    const supabase = createClient();
    await supabase.from("conversations").update({ tags: newTags }).eq("id", conversationId);
    setInput("");
    onUpdate();
  };

  const handleRemove = async (tag: string) => {
    const newTags = tags.filter((t) => t !== tag);
    const supabase = createClient();
    await supabase.from("conversations").update({ tags: newTags }).eq("id", conversationId);
    onUpdate();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1">
            {tag}
            <button onClick={() => handleRemove(tag)}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        placeholder="Adicionar tag..."
        className="h-8 text-xs"
      />
    </div>
  );
}
```

- [ ] **Step 2: Criar notes-panel.tsx**

Criar `apps/web/src/components/inbox/notes-panel.tsx`:
```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import type { ConversationNote } from "@aula-agente/shared";

interface NotesPanelProps {
  conversationId: string;
  organizationId: string;
}

export function NotesPanel({ conversationId, organizationId }: NotesPanelProps) {
  const [notes, setNotes] = useState<ConversationNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchNotes = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversation_notes")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });
    setNotes((data as ConversationNote[]) || []);
  }, [conversationId]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  const handleAdd = async () => {
    if (!newNote.trim()) return;
    setSaving(true);

    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    await supabase.from("conversation_notes").insert({
      conversation_id: conversationId,
      organization_id: organizationId,
      user_id: user!.id,
      content: newNote.trim(),
    });

    setNewNote("");
    setSaving(false);
    fetchNotes();
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Textarea
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="Nota interna..."
          rows={2}
          className="text-xs"
        />
        <Button size="icon" onClick={handleAdd} disabled={saving || !newNote.trim()}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-2">
        {notes.map((note) => (
          <div key={note.id} className="rounded-md bg-yellow-50 p-2 text-xs dark:bg-yellow-900/20">
            <p>{note.content}</p>
            <p className="mt-1 text-muted-foreground">
              {new Date(note.created_at).toLocaleString("pt-BR")}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Criar side-panel.tsx (integra tudo)**

Criar `apps/web/src/components/inbox/side-panel.tsx`:
```tsx
"use client";

import { TakeoverBar } from "./takeover-bar";
import { TagsInput } from "./tags-input";
import { NotesPanel } from "./notes-panel";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import type { ConversationStatus } from "@aula-agente/shared";

interface SidePanelProps {
  conversation: {
    id: string;
    organization_id: string;
    status: ConversationStatus;
    is_human_takeover: boolean;
    assigned_to: string | null;
    tags: string[];
    contacts: { phone: string; name: string | null };
  };
  onUpdate: () => void;
}

export function SidePanel({ conversation, onUpdate }: SidePanelProps) {
  const handleStatusChange = async (status: string) => {
    const supabase = createClient();
    await supabase
      .from("conversations")
      .update({ status })
      .eq("id", conversation.id);
    onUpdate();
  };

  return (
    <div className="w-72 space-y-4 overflow-y-auto border-l p-4">
      {/* Contact Info */}
      <div>
        <h3 className="text-sm font-semibold">Contato</h3>
        <p className="text-sm">{conversation.contacts.name || "Sem nome"}</p>
        <p className="text-xs text-muted-foreground">{conversation.contacts.phone}</p>
      </div>

      <Separator />

      {/* Status */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Status</h3>
        <Select value={conversation.status} onValueChange={handleStatusChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Aberto</SelectItem>
            <SelectItem value="waiting">Aguardando</SelectItem>
            <SelectItem value="resolved">Resolvido</SelectItem>
            <SelectItem value="closed">Fechado</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Takeover */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Atendimento</h3>
        <TakeoverBar
          conversationId={conversation.id}
          isHumanTakeover={conversation.is_human_takeover}
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

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/inbox/
git commit -m "feat(web): add side panel with takeover, tags, notes, and status"
```

---

### Task 5: Integrar Side Panel no Chat

**Files:**
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`

- [ ] **Step 1: Atualizar chat-panel.tsx para incluir side panel**

Adicionar importacao e renderizacao do SidePanel ao lado do chat no `chat-panel.tsx`. Atualizar o componente para incluir:

```tsx
// No topo, adicionar import:
import { SidePanel } from "./side-panel";

// No return, envolver chat + side panel em flex:
// <div className="flex h-full w-full">
//   <div className="flex flex-1 flex-col">
//     {/* header, messages, input existentes */}
//   </div>
//   {conversation && (
//     <SidePanel conversation={conversation} onUpdate={fetchConversation} />
//   )}
// </div>
```

O chat panel completo com side panel integrado:

Substituir `apps/web/src/components/inbox/chat-panel.tsx`:
```tsx
"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { apiFetch } from "@/lib/api";
import { MessageBubble } from "./message-bubble";
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
      .select("*, contacts(phone, name)")
      .eq("id", conversationId)
      .single();
    setConversation(data);
  }, [conversationId]);

  useEffect(() => {
    fetchMessages();
    fetchConversation();
  }, [fetchMessages, fetchConversation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useRealtime<Message>({
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`,
    onInsert: (newMsg) => {
      setMessages((prev) => [...prev, newMsg]);
    },
  });

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
        {/* Header */}
        <div className="border-b px-4 py-3">
          <p className="font-medium">
            {conversation?.contacts?.name || conversation?.contacts?.phone || "Conversa"}
          </p>
          <p className="text-xs text-muted-foreground">{conversation?.contacts?.phone}</p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t p-4">
          <div className="flex gap-2">
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

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/inbox/chat-panel.tsx
git commit -m "feat(web): integrate side panel into chat view"
```

---

### Task 6: Verificacao Final da Fase 7

- [ ] **Step 1: Verificar build**

```bash
cd apps/web && pnpm build
```

- [ ] **Step 2: Commit final**

```bash
git add -A && git status
git commit -m "chore: phase 7 final adjustments"
```
