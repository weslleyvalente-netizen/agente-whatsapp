"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { computeChangedSectionDetails } from "@aula-agente/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import type { AgentConfigStatus } from "./use-agent-config";

interface PublishDialogProps {
  agentId: string;
  status: AgentConfigStatus;
  onPublished: () => Promise<void>;
}

export function PublishDialog({ agentId, status, onPublished }: PublishDialogProps) {
  const [changelog, setChangelog] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [open, setOpen] = useState(false);

  const baseSnapshot = status.latestVersion
    ? { ...status.latestVersion.config_snapshot, tools_config: status.latestVersion.tools_config }
    : null;
  const details = computeChangedSectionDetails(status.draft, baseSnapshot);

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
      <DialogTrigger render={<Button disabled={!status.hasPendingChanges}>Publicar</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publicar alterações</DialogTitle>
          <DialogDescription>Isto atualiza a Helena que atende no WhatsApp agora.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {details.length === 0 && <p className="text-muted-foreground">Nenhuma seção alterada.</p>}
          {details.map((detail) => (
            <div key={detail.section}>
              <p className="font-medium">{detail.label}</p>
              {detail.items.length > 0 && (
                <ul className="ml-4 list-disc text-muted-foreground">
                  {detail.items.map((item) => (
                    <li key={item.key}>{item.label}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
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
