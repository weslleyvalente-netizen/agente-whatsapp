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
  { key: "update_qualification", title: "Atualizar dados de qualificação", description: "Permite ao agente registrar automaticamente produto de interesse, valores, CPF e outros dados comerciais durante a conversa" },
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

  // The two hour inputs below only touch local state on every keystroke
  // (setLocalFollowup) — matching this codebase's convention for numeric
  // fields elsewhere in agent config (see geral-section.tsx's max_tokens
  // input) — and only call patchFollowup, which actually saves, on blur.
  // Saving on every keystroke sent overlapping PATCH requests whose
  // responses could race and revert each other's value, and
  // Number(e.target.value) on a cleared or non-numeric field produced NaN
  // sent straight to the API.
  const setLocalFollowup = (next: FollowupAutomaticoConfig) => {
    setToolsConfig({ ...toolsConfig, followup_automatico: next });
  };

  const commitFollowupHours = () => {
    patchFollowup({
      ...followup,
      primeiro_followup_horas: Number.isFinite(followup.primeiro_followup_horas) && followup.primeiro_followup_horas >= 0.5
        ? followup.primeiro_followup_horas
        : DEFAULT_FOLLOWUP_AUTOMATICO.primeiro_followup_horas,
      segundo_followup_horas: Number.isFinite(followup.segundo_followup_horas) && followup.segundo_followup_horas >= 0.5
        ? followup.segundo_followup_horas
        : DEFAULT_FOLLOWUP_AUTOMATICO.segundo_followup_horas,
    });
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
                checked={toolsConfig[row.key] ?? false}
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
                value={Number.isNaN(followup.primeiro_followup_horas) ? "" : followup.primeiro_followup_horas}
                disabled={!followup.ativo}
                onChange={(e) =>
                  setLocalFollowup({
                    ...followup,
                    primeiro_followup_horas: e.target.value === "" ? NaN : Number(e.target.value),
                  })
                }
                onBlur={commitFollowupHours}
              />
            </div>
            <div className="space-y-2">
              <Label>2ª tentativa (horas sem resposta)</Label>
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={Number.isNaN(followup.segundo_followup_horas) ? "" : followup.segundo_followup_horas}
                disabled={!followup.ativo}
                onChange={(e) =>
                  setLocalFollowup({
                    ...followup,
                    segundo_followup_horas: e.target.value === "" ? NaN : Number(e.target.value),
                  })
                }
                onBlur={commitFollowupHours}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
