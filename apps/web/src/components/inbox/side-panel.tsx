"use client";

import { AssignSelect } from "./assign-select";
import { TagsInput } from "./tags-input";
import { NotesPanel } from "./notes-panel";
import { Separator } from "@/components/ui/separator";

interface SidePanelProps {
  conversation: {
    id: string;
    organization_id: string;
    assigned_to: string | null;
    tags: string[];
    wa_contacts: { phone: string; name: string | null };
  };
  onUpdate: () => void;
}

export function SidePanel({ conversation, onUpdate }: SidePanelProps) {
  return (
    <div className="w-72 space-y-4 overflow-y-auto border-l p-4">
      {/* Contact Info */}
      <div>
        <h3 className="text-sm font-semibold">Contato</h3>
        <p className="text-sm">{conversation.wa_contacts.name || "Sem nome"}</p>
        <p className="text-xs text-muted-foreground">{conversation.wa_contacts.phone}</p>
      </div>

      <Separator />

      {/* Assignment */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Atribuido a</h3>
        <AssignSelect
          conversationId={conversation.id}
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
