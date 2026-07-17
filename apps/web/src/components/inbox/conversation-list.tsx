"use client";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { User } from "lucide-react";

interface ConversationItem {
  id: string;
  status: string;
  is_human_takeover: boolean;
  last_message_at: string;
  tags: string[];
  assigned_to: string | null;
  wa_contacts: {
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
              {conv.wa_contacts.name?.[0]?.toUpperCase() || <User className="h-4 w-4" />}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 overflow-hidden">
            <div className="flex items-center justify-between">
              <p className="truncate text-sm font-medium">
                {conv.wa_contacts.name || conv.wa_contacts.phone}
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
