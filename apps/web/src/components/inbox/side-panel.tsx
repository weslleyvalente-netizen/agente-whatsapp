"use client";

import { TagsInput } from "./tags-input";
import { NotesPanel } from "./notes-panel";
import { Separator } from "@/components/ui/separator";
import { formatPhone } from "@/lib/utils";

interface SidePanelProps {
  conversation: {
    id: string;
    organization_id: string;
    tags: string[];
    wa_contacts: { phone: string; name: string | null };
  };
  onUpdate: () => void;
}

export function SidePanel({ conversation, onUpdate }: SidePanelProps) {
  return (
    <div className="space-y-4 overflow-y-auto p-4">
      {/* Contact Info */}
      <div>
        <h3 className="text-sm font-semibold">Contato</h3>
        <p className="text-sm">{conversation.wa_contacts.name || "Sem nome"}</p>
        <p className="text-xs text-muted-foreground">{formatPhone(conversation.wa_contacts.phone)}</p>
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
