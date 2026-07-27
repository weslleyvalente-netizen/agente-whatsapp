"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogClose,
} from "@/components/ui/dialog";
import type { AgentVersion } from "@aula-agente/shared";

const SECTION_LABELS: Record<string, string> = {
  identity: "Identidade", personality: "Personalidade", rules: "Regras", knowledge: "Conhecimento", playbook: "Playbook",
};

interface HistoryPanelProps {
  agentId: string;
  onRestored: () => Promise<void>;
}

export function HistoryPanel({ agentId, onRestored }: HistoryPanelProps) {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  const [changedSections, setChangedSections] = useState<string[]>([]);
  const [restoring, setRestoring] = useState(false);

  const fetchVersions = useCallback(async () => {
    const data = (await apiFetch(`/agents/${agentId}/versions`)) as AgentVersion[];
    setVersions(data);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const openDiff = async (versionId: string) => {
    const detail = (await apiFetch(`/agents/${agentId}/versions/${versionId}`)) as { changedSections: string[] };
    setChangedSections(detail.changedSections);
    setOpenVersionId(versionId);
  };

  const handleRestore = async () => {
    if (!openVersionId) return;
    setRestoring(true);
    try {
      await apiFetch(`/agents/${agentId}/versions/${openVersionId}/restore`, { method: "POST" });
      setOpenVersionId(null);
      await onRestored();
    } finally {
      setRestoring(false);
    }
  };

  if (loading) return <p className="text-sm text-muted-foreground">Carregando histórico...</p>;
  if (versions.length === 0) return <p className="text-sm text-muted-foreground">Nenhuma versão publicada ainda.</p>;

  return (
    <div className="space-y-3">
      {versions.map((version) => (
        <Card key={version.id}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">v{version.version}</CardTitle>
              <Badge variant="outline">{new Date(version.created_at).toLocaleString("pt-BR")}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">{version.changelog}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => openDiff(version.id)}>
              Ver e restaurar
            </Button>
          </CardContent>
        </Card>
      ))}

      <Dialog open={openVersionId !== null} onOpenChange={(open) => !open && setOpenVersionId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restaurar esta versão para o rascunho?</DialogTitle>
            <DialogDescription>
              {changedSections.length > 0
                ? `Seções desta versão em relação à anterior: ${changedSections.map((s) => SECTION_LABELS[s] ?? s).join(", ")}.`
                : "Esta versão é idêntica à anterior."}{" "}
              Isso substitui o rascunho atual — não publica nada sozinho, e não apaga nenhuma versão.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancelar</Button>} />
            <Button onClick={handleRestore} disabled={restoring}>
              {restoring ? "Restaurando..." : "Restaurar para o rascunho"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
