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

// `analyzeConversations` is what actually makes the backend read real
// customer messages — it is carried by the quick action itself, not sniffed
// out of the prompt text, so rewording the prefilled prompt before sending
// can neither lose the behaviour nor trigger it by accident.
const QUICK_ACTIONS: { label: string; prompt: string; analyzeConversations?: boolean }[] = [
  { label: "Analisar conversas reais", prompt: "Veja as últimas conversas e sugira melhorias na configuração.", analyzeConversations: true },
  { label: "Caçar inconsistências", prompt: "Procure regras conflitantes ou duplicadas na configuração atual." },
  { label: "Ajustar o tom", prompt: "Deixe o tom mais animado." },
  { label: "Regras de negociação", prompt: "Nunca dê desconto sem confirmar antes." },
];

export function TrainerPanel({ trainer }: TrainerPanelProps) {
  const { messages, sendMessage, sending, decideProposal } = trainer;
  const [draft, setDraft] = useState("");
  // Quick actions only prefill the input, so the "analyse real conversations"
  // intent has to survive from the click until the user actually sends. Any
  // manual edit to the input clears it: at that point the text is the user's
  // own, and opting them into a scan of real customer messages would be a
  // decision they never made.
  const [analyzeConversations, setAnalyzeConversations] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const analyze = analyzeConversations;
    setDraft("");
    setAnalyzeConversations(false);
    await sendMessage(text, { analyzeConversations: analyze });
  };

  return (
    <div className="flex h-full min-h-[400px] flex-col rounded-md border">
      <div className="border-b p-3">
        <p className="mb-2 text-sm font-medium">Treine a Helena conversando</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((action) => (
            <Button
              key={action.label}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(action.prompt);
                setAnalyzeConversations(action.analyzeConversations ?? false);
              }}
              disabled={sending}
            >
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
      <div className="border-t p-3">
        {analyzeConversations && (
          <p className="mb-2 text-xs text-muted-foreground">
            Esta mensagem vai analisar conversas reais recentes. Editar o texto desativa.
          </p>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setAnalyzeConversations(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Digite uma mudança..."
            disabled={sending}
          />
          <Button type="button" size="icon" onClick={() => handleSend()} disabled={sending}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
