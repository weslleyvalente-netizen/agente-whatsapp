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
