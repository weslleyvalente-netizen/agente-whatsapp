"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";

const SECTION_LABELS: Record<string, string> = {
  identity: "Identidade", personality: "Personalidade", rules: "Regras", knowledge: "Conhecimento", playbook: "Playbook",
};

interface PublishDialogProps {
  agentId: string;
  changedSections: string[];
  onPublished: () => Promise<void>;
}

export function PublishDialog({ agentId, changedSections, onPublished }: PublishDialogProps) {
  const [changelog, setChangelog] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [open, setOpen] = useState(false);

  const handlePublish = async () => {
    setPublishing(true);
    try {
      await apiFetch(`/agents/${agentId}/config/publish`, {
        method: "POST",
        body: JSON.stringify({ changelog }),
      });
      setChangelog("");
      setOpen(false);
      await onPublished();
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button disabled={changedSections.length === 0}>Publicar</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publicar alterações</DialogTitle>
          <DialogDescription>
            Isto atualiza a Helena que atende no WhatsApp agora. Seções alteradas: {changedSections.map((s) => SECTION_LABELS[s] ?? s).join(", ") || "nenhuma"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Changelog</Label>
          <Textarea value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="O que mudou e por quê" />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancelar</Button>} />
          <Button onClick={handlePublish} disabled={publishing || !changelog.trim()}>
            {publishing ? "Publicando..." : "Publicar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
