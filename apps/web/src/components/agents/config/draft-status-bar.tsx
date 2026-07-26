"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import { PublishDialog } from "./publish-dialog";
import type { AgentConfigStatus } from "./use-agent-config";

interface DraftStatusBarProps {
  agentId: string;
  status: AgentConfigStatus;
  onPublished: () => Promise<void>;
}

export function DraftStatusBar({ agentId, status, onPublished }: DraftStatusBarProps) {
  const [discarding, setDiscarding] = useState(false);

  const handleDiscard = async () => {
    setDiscarding(true);
    try {
      await apiFetch(`/agents/${agentId}/config/discard`, { method: "POST" });
      await onPublished();
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-2">
      <Badge variant={status.hasPendingChanges ? "default" : "secondary"}>
        {status.hasPendingChanges
          ? `${status.changedSections.length} alteração(ões) não publicada(s)`
          : "Tudo publicado"}
      </Badge>
      <div className="flex items-center gap-2">
        <Dialog>
          <DialogTrigger render={<Button variant="outline" disabled={!status.latestVersion || discarding}>Descartar</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Descartar alterações?</DialogTitle>
              <DialogDescription>
                O rascunho volta para o que está publicado atualmente (versão {status.latestVersion?.version}). Isso não pode ser desfeito.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Cancelar</Button>} />
              <DialogClose render={<Button variant="destructive" onClick={handleDiscard}>Descartar</Button>} />
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <PublishDialog agentId={agentId} changedSections={status.changedSections} onPublished={onPublished} />
      </div>
    </div>
  );
}
