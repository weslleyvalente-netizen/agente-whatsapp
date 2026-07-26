"use client";

import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentConfigDraft, AgentPlaybook } from "@aula-agente/shared";

interface PlaybooksSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { playbook: AgentPlaybook }) => Promise<void>;
}

export function PlaybooksSection({ draft, onPatch }: PlaybooksSectionProps) {
  const [playbook, setPlaybook] = useState(draft.playbook);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Script de atendimento</CardTitle>
      </CardHeader>
      <CardContent>
        <Textarea
          rows={16}
          value={playbook.script_atendimento}
          placeholder={"1. Identificação da necessidade\n2. Qualificação\n3. Direcionamento\n4. Próximo passo"}
          onChange={(e) => setPlaybook({ script_atendimento: e.target.value })}
          onBlur={() => onPatch({ playbook })}
        />
        <p className="mt-2 text-sm text-muted-foreground">
          Playbooks futuros por tipo de atendimento (Consórcio, Financiamento, Venda de moto, Carta contemplada,
          Follow-up) já têm espaço reservado no modelo de dados — não são criados nesta etapa, apenas este script
          único de atendimento geral, migrado sem inventar novo conteúdo.
        </p>
      </CardContent>
    </Card>
  );
}
