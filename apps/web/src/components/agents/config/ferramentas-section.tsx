"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentConfigDraft, ToolsConfig, FollowupAutomaticoConfig } from "@aula-agente/shared";
import { DEFAULT_FOLLOWUP_AUTOMATICO } from "@aula-agente/shared";

interface ToolRow {
  key: Exclude<keyof ToolsConfig, "followup_automatico">;
  title: string;
  description: string;
}

const TOOL_ROWS: ToolRow[] = [
  { key: "search_knowledge", title: "Busca na Base de Conhecimento", description: "Permite ao agente buscar em documentos enviados" },
  { key: "search_faq", title: "Busca de FAQs", description: "Permite ao agente consultar perguntas frequentes" },
  { key: "send_catalog_photo", title: "Catálogo de Veículos", description: "Permite ao agente buscar veículos e enviar fotos pelo WhatsApp" },
  { key: "create_task", title: "Criar tarefas de follow-up", description: "Permite ao agente criar tarefas de acompanhamento comercial em Tarefas" },
];

interface FerramentasSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { tools_config: ToolsConfig }) => Promise<void>;
}

export function FerramentasSection({ draft, onPatch }: FerramentasSectionProps) {
  const [toolsConfig, setToolsConfig] = useState(draft.tools_config);
  const followup = toolsConfig.followup_automatico ?? DEFAULT_FOLLOWUP_AUTOMATICO;

  const patchFollowup = (next: FollowupAutomaticoConfig) => {
    const nextToolsConfig = { ...toolsConfig, followup_automatico: next };
    setToolsConfig(nextToolsConfig);
    onPatch({ tools_config: nextToolsConfig });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Ferramentas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {TOOL_ROWS.map((row) => (
            <div key={row.key} className="flex items-center justify-between">
              <div>
                <p className="font-medium">{row.title}</p>
                <p className="text-sm text-muted-foreground">{row.description}</p>
              </div>
              <Switch
                checked={toolsConfig[row.key]}
                onCheckedChange={(v) => {
                  const next = { ...toolsConfig, [row.key]: v };
                  setToolsConfig(next);
                  onPatch({ tools_config: next });
                }}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Followup automático</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Reengajar cliente que parou de responder</p>
              <p className="text-sm text-muted-foreground">
                Quando o cliente não responde depois de uma mensagem da Helena, ela tenta
                retomar o contato automaticamente, em até 2 tentativas.
              </p>
            </div>
            <Switch
              checked={followup.ativo}
              onCheckedChange={(v) => patchFollowup({ ...followup, ativo: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>1ª tentativa (horas sem resposta)</Label>
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={followup.primeiro_followup_horas}
                disabled={!followup.ativo}
                onChange={(e) =>
                  patchFollowup({ ...followup, primeiro_followup_horas: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>2ª tentativa (horas sem resposta)</Label>
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={followup.segundo_followup_horas}
                disabled={!followup.ativo}
                onChange={(e) =>
                  patchFollowup({ ...followup, segundo_followup_horas: Number(e.target.value) })
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
