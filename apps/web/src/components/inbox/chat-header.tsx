"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AssignSelect } from "./assign-select";
import { UserCheck, Bot, Info, X } from "lucide-react";
import type { ConversationStatus } from "@aula-agente/shared";
import { formatPhone } from "@/lib/utils";

const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Aberto",
  waiting: "Aguardando",
  resolved: "Resolvido",
  closed: "Fechado",
};

const PILL_TRIGGER_CLASS =
  "h-8 w-auto rounded-full border-border bg-background px-3 text-xs font-medium";

interface ChatHeaderProps {
  conversation: {
    id: string;
    organization_id: string;
    assigned_to: string | null;
    status: ConversationStatus;
    is_human_takeover: boolean;
    wa_contacts: { phone: string; name: string | null } | null;
    agents?: { name: string } | null;
  };
  onStatusChange: (status: string) => void;
  onTakeoverToggle: () => void;
  onUpdate: () => void;
  onOpenDetails: () => void;
  onClose: () => void;
}

export function ChatHeader({
  conversation,
  onStatusChange,
  onTakeoverToggle,
  onUpdate,
  onOpenDetails,
  onClose,
}: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {conversation.wa_contacts?.name || formatPhone(conversation.wa_contacts?.phone) || "Conversa"}
        </p>
        <p className="text-xs text-muted-foreground">{formatPhone(conversation.wa_contacts?.phone)}</p>
        {conversation.agents?.name && (
          <p className="text-xs text-muted-foreground">Agente: {conversation.agents.name}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Select value={conversation.status} onValueChange={(v) => v && onStatusChange(v)}>
          <SelectTrigger className={PILL_TRIGGER_CLASS}>
            <SelectValue>{(value: ConversationStatus) => STATUS_LABELS[value] ?? value}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Aberto</SelectItem>
            <SelectItem value="waiting">Aguardando</SelectItem>
            <SelectItem value="resolved">Resolvido</SelectItem>
            <SelectItem value="closed">Fechado</SelectItem>
          </SelectContent>
        </Select>

        <AssignSelect
          conversationId={conversation.id}
          assignedTo={conversation.assigned_to}
          organizationId={conversation.organization_id}
          onUpdate={onUpdate}
          triggerClassName={PILL_TRIGGER_CLASS}
        />

        <Button
          variant={conversation.is_human_takeover ? "default" : "outline"}
          size="sm"
          className="rounded-full"
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

        <Button variant="ghost" size="icon" onClick={onOpenDetails} aria-label="Detalhes da conversa">
          <Info className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Fechar conversa">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
