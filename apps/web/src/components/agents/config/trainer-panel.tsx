"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Send } from "lucide-react";
import { TrainerProposalCard } from "./trainer-proposal-card";
import type { useTrainerSession } from "./use-trainer-session";

interface TrainerPanelProps {
  trainer: ReturnType<typeof useTrainerSession>;
}

const QUICK_ACTIONS = [
  { label: "Analisar conversas reais", prompt: "Veja as últimas conversas e sugira melhorias na configuração." },
  { label: "Caçar inconsistências", prompt: "Procure regras conflitantes ou duplicadas na configuração atual." },
  { label: "Ajustar o tom", prompt: "Deixe o tom mais animado." },
  { label: "Regras de negociação", prompt: "Nunca dê desconto sem confirmar antes." },
];

export function TrainerPanel({ trainer }: TrainerPanelProps) {
  const { messages, sendMessage, sending, decideProposal } = trainer;
  const [draft, setDraft] = useState("");
  const messageListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = async (content?: string) => {
    const text = (content ?? draft).trim();
    if (!text || sending) return;
    setDraft("");
    await sendMessage(text);
  };

  return (
    <div className="flex h-full min-h-[400px] flex-col rounded-md border">
      <div className="border-b p-3">
        <p className="mb-2 text-sm font-medium">Treine a Helena conversando</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((action) => (
            <Button key={action.label} type="button" variant="outline" size="sm" onClick={() => handleSend(action.prompt)} disabled={sending}>
              {action.label}
            </Button>
          ))}
        </div>
      </div>
      <div ref={messageListRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Peça uma mudança de comportamento para a Helena, como &quot;deixa o tom mais animado&quot;.
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] space-y-2 rounded-lg px-3 py-2 text-sm",
                message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
              )}
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              {message.proposals.map((proposal) => (
                <TrainerProposalCard key={proposal.id} proposal={proposal} onDecide={decideProposal} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t p-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Digite uma mudança..."
          disabled={sending}
        />
        <Button type="button" size="icon" onClick={() => handleSend()} disabled={sending}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
