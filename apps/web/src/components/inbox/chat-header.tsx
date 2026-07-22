"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { UserCheck, Bot } from "lucide-react";
import type { ConversationStatus } from "@aula-agente/shared";

interface ChatHeaderProps {
  conversation: {
    status: ConversationStatus;
    is_human_takeover: boolean;
    wa_contacts: { phone: string; name: string | null } | null;
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
          {conversation.wa_contacts?.name || conversation.wa_contacts?.phone || "Conversa"}
        </p>
        <p className="text-xs text-muted-foreground">{conversation.wa_contacts?.phone}</p>
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
