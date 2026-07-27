"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import type { AgentConfigSections } from "@aula-agente/shared";

interface ImportSystemPromptDialogProps {
  agentId: string;
  onApplied: () => Promise<void>;
}

export function ImportSystemPromptDialog({ agentId, onApplied }: ImportSystemPromptDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentSystemPrompt, setCurrentSystemPrompt] = useState("");
  const [suggestion, setSuggestion] = useState<AgentConfigSections | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = async (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen && !suggestion) {
      setError(null);
      setLoading(true);
      try {
        const data = (await apiFetch(`/agents/${agentId}/config/import-suggestion`, { method: "POST" })) as {
          currentSystemPrompt: string;
          suggestion: AgentConfigSections;
        };
        setCurrentSystemPrompt(data.currentSystemPrompt);
        setSuggestion(data.suggestion);
      } catch (err) {
        setError((err as Error).message || "Não foi possível gerar a sugestão.");
      } finally {
        setLoading(false);
      }
    }
  };

  const handleApply = async () => {
    if (!suggestion) return;
    setApplying(true);
    try {
      await apiFetch(`/agents/${agentId}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          identity: suggestion.identity,
          personality: suggestion.personality,
          rules: suggestion.rules,
          knowledge: suggestion.knowledge,
          playbook: suggestion.playbook,
        }),
      });
      setOpen(false);
      setSuggestion(null);
      await onApplied();
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button type="button" variant="outline">Importar configuração atual</Button>} />
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Importar configuração atual</DialogTitle>
          <DialogDescription>
            A IA sugere como dividir o texto publicado hoje entre Identidade, Personalidade, Regras, Conhecimento e
            Playbook. Revise e edite antes de aplicar — nada é salvo até você clicar em "Aplicar ao rascunho".
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Analisando o texto atual...</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !suggestion ? (
          <p className="text-sm text-muted-foreground">Analisando o texto atual...</p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Texto atual (system prompt publicado)</Label>
              <Textarea readOnly rows={20} value={currentSystemPrompt} className="font-mono text-xs" />
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Identidade — Nome</Label>
                <Input
                  value={suggestion.identity.nome}
                  onChange={(e) => setSuggestion({ ...suggestion, identity: { ...suggestion.identity, nome: e.target.value } })}
                />
              </div>
              <div className="space-y-2">
                <Label>Identidade — Função</Label>
                <Input
                  value={suggestion.identity.funcao}
                  onChange={(e) => setSuggestion({ ...suggestion, identity: { ...suggestion.identity, funcao: e.target.value } })}
                />
              </div>
              <div className="space-y-2">
                <Label>Identidade — Missão</Label>
                <Textarea
                  rows={4}
                  value={suggestion.identity.missao}
                  onChange={(e) => setSuggestion({ ...suggestion, identity: { ...suggestion.identity, missao: e.target.value } })}
                />
              </div>
              <div className="space-y-2">
                <Label>Playbook — Script de atendimento</Label>
                <Textarea
                  rows={6}
                  value={suggestion.playbook.script_atendimento}
                  onChange={(e) => setSuggestion({ ...suggestion, playbook: { script_atendimento: e.target.value } })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Personalidade, Regras e Conhecimento completos ficam disponíveis para ajuste fino nas próprias abas
                depois de aplicar — aqui você revisa o essencial antes de decidir.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline">Cancelar</Button>} />
          <Button type="button" onClick={handleApply} disabled={!suggestion || applying}>
            {applying ? "Aplicando..." : "Aplicar ao rascunho"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
