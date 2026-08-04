"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentConfigDraft, ToolsConfig } from "@aula-agente/shared";

interface ToolRow {
  key: keyof ToolsConfig;
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

  return (
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
  );
}
