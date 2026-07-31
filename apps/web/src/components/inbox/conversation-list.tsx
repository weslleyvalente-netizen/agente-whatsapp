"use client";

import { cn, formatPhone } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { StatusLamp, type LampTone } from "@/components/ui/status-lamp";
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
  messages?: Array<{ content: string; created_at: string }>;
}

interface ConversationListProps {
  conversations: ConversationItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// Derived purely from fields already on the conversation — no schema change.
// Mirrors the multi-badge pattern seen in Assis: a conversation the AI is
// handling fine shows no badge at all (visual noise reduction), while one
// that needs human eyes stacks up to three.
function getConversationTags(conv: ConversationItem): Array<{ label: string; variant: "secondary" | "destructive" | "outline" }> {
  const tags: Array<{ label: string; variant: "secondary" | "destructive" | "outline" }> = [];
  if (conv.status === "open" || conv.status === "waiting") {
    tags.push({ label: "Em andamento", variant: "secondary" });
  }
  if (conv.is_human_takeover) {
    tags.push({ label: "Atenção Humana", variant: "destructive" });
    if (!conv.assigned_to) {
      tags.push({ label: "Disponível para assumir", variant: "outline" });
    }
  }
  return tags;
}

export function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {
  const statusLamp: Record<string, LampTone> = {
    open: "green",
    waiting: "amber",
    resolved: "off",
    closed: "off",
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
          <div className="relative shrink-0">
            <Avatar className="h-10 w-10 bg-primary/10 text-primary">
              <AvatarFallback className="bg-primary/10 font-medium text-primary">
                {conv.wa_contacts.name?.[0]?.toUpperCase() || <User className="h-4 w-4" />}
              </AvatarFallback>
            </Avatar>
            <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-background p-[3px]">
              <StatusLamp tone={statusLamp[conv.status] || "off"} pulse={conv.status === "waiting"} />
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">
                {conv.wa_contacts.name || formatPhone(conv.wa_contacts.phone)}
              </p>
              <span className="shrink-0 text-xs text-muted-foreground tabular-data">
                {new Date(conv.last_message_at).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {conv.messages?.[0]?.content || conv.agents.name}
            </p>
            {(() => {
              const tags = getConversationTags(conv);
              if (tags.length === 0) return null;
              return (
                <div className="mt-1 flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <Badge key={tag.label} variant={tag.variant} className="h-4 px-1.5 text-[10px]">
                      {tag.label}
                    </Badge>
                  ))}
                </div>
              );
            })()}
          </div>
        </button>
      ))}
    </div>
  );
}
