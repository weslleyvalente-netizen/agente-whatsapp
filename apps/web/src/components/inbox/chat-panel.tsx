"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { apiFetch } from "@/lib/api";
import { useRouter } from "next/navigation";
import { MessageBubble } from "./message-bubble";
import { ChatHeader } from "./chat-header";
import { SidePanel } from "./side-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Send } from "lucide-react";
import type { Message } from "@aula-agente/shared";

interface ChatPanelProps {
  conversationId: string;
}

export function ChatPanel({ conversationId }: ChatPanelProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversation, setConversation] = useState<any>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
    onUpdate: (updatedMsg) => {
      setMessages((prev) => prev.map((m) => (m.id === updatedMsg.id ? updatedMsg : m)));
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
      <div className="flex min-w-0 flex-1 flex-col">
        {conversation && (
          <ChatHeader
            conversation={conversation}
            onStatusChange={handleStatusChange}
            onTakeoverToggle={handleTakeoverToggle}
            onUpdate={fetchConversation}
            onOpenDetails={() => setDetailsOpen(true)}
            onClose={() => router.push("/inbox")}
          />
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3">
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
              className="rounded-full"
            />
            <Button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              size="icon"
              className="rounded-full"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Detalhes da conversa</SheetTitle>
          </SheetHeader>
          {conversation && <SidePanel conversation={conversation} onUpdate={fetchConversation} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
