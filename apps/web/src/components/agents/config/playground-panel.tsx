"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { RotateCcw, Send } from "lucide-react";
import type { usePlaygroundSession } from "./use-playground-session";

interface PlaygroundPanelProps {
  playground: ReturnType<typeof usePlaygroundSession>;
}

export function PlaygroundPanel({ playground }: PlaygroundPanelProps) {
  const { messages, sendMessage, sending, reset } = playground;
  const [draft, setDraft] = useState("");
  const messageListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setDraft("");
    await sendMessage(content);
  };

  return (
    <div className="flex h-full min-h-[400px] flex-col rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <p className="text-sm font-medium">Playground</p>
        <Button type="button" variant="ghost" size="icon-sm" onClick={reset} title="Nova conversa">
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
      <div ref={messageListRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">Mande uma mensagem como se fosse um lead.</p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
              )}
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              {message.tool_calls.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-current/20 pt-2">
                  {message.tool_calls.map((call, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs opacity-80">
                      <Badge variant={call.mode === "simulated" ? "secondary" : "outline"} className="text-[10px]">
                        {call.mode === "simulated" ? "SIMULADO" : "REAL"}
                      </Badge>
                      <span>{call.tool_name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t p-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Mande uma mensagem como se fosse um lead..."
          disabled={sending}
        />
        <Button type="button" size="icon" onClick={handleSend} disabled={sending}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
