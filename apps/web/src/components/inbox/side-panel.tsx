"use client";

import { TakeoverBar } from "./takeover-bar";
import { TagsInput } from "./tags-input";
import { NotesPanel } from "./notes-panel";
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
        <Select value={conversation.status} onValueChange={(v) => v && handleStatusChange(v)}>
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
