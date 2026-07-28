"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAgentConfig } from "@/components/agents/config/use-agent-config";
import { usePlaygroundSession } from "@/components/agents/config/use-playground-session";
import { DraftStatusBar } from "@/components/agents/config/draft-status-bar";
import { PlaygroundPanel } from "@/components/agents/config/playground-panel";
import { GeralSection } from "@/components/agents/config/geral-section";
import { PersonalidadeSection, type PersonalidadeItemKey } from "@/components/agents/config/personalidade-section";
import { RegrasSection, type RegrasItemKey } from "@/components/agents/config/regras-section";
import { ConhecimentoSection, type ConhecimentoItemKey } from "@/components/agents/config/conhecimento-section";
import { PlaybooksSection } from "@/components/agents/config/playbooks-section";
import { FerramentasSection } from "@/components/agents/config/ferramentas-section";
import { HistoryPanel } from "@/components/agents/config/history-panel";
import { ConfigTreeNav, type TreeNode } from "@/components/agents/config/config-tree-nav";
import { useTrainerSession } from "@/components/agents/config/use-trainer-session";
import { TrainerPanel } from "@/components/agents/config/trainer-panel";
import { Badge } from "@/components/ui/badge";
import { SECTION_ORDER, SECTION_ITEMS, SECTION_LABELS } from "@aula-agente/shared";

const TREE: TreeNode[] = SECTION_ORDER.map((key) => {
  const items = SECTION_ITEMS[key];
  return items
    ? { type: "group" as const, key, label: SECTION_LABELS[key], items: Object.entries(items).map(([itemKey, label]) => ({ key: itemKey, label })) }
    : { type: "leaf" as const, key, label: SECTION_LABELS[key] };
});

function findLabel(sectionKey: string, itemKey: string | null): { sectionLabel: string; itemLabel: string | null } {
  const node = TREE.find((n) => n.key === sectionKey);
  const sectionLabel = node?.label ?? sectionKey;
  if (!node || node.type === "leaf" || !itemKey) return { sectionLabel, itemLabel: null };
  const item = node.items.find((i) => i.key === itemKey);
  return { sectionLabel, itemLabel: item?.label ?? null };
}

export default function AgentEditarPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { status, loading, patch, refetch } = useAgentConfig(agentId);
  const [selectedSection, setSelectedSection] = useState("geral");
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    personalidade: true,
    regras: true,
    conhecimento: true,
  });
  const playground = usePlaygroundSession(agentId);
  const trainer = useTrainerSession(agentId);

  if (loading || !status) return <div className="p-6">Carregando configuração...</div>;

  const { sectionLabel, itemLabel } = findLabel(selectedSection, selectedItem);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <DraftStatusBar agentId={agentId} status={status} onPublished={refetch} />
      <Tabs defaultValue="editar" className="min-h-0 flex-1">
        <TabsList variant="line">
          <TabsTrigger value="editar">Editar</TabsTrigger>
          <TabsTrigger value="playground">Playground</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="trainer">
            Trainer
            {trainer.pendingProposalsCount > 0 && (
              <Badge variant="default" className="h-4 min-w-4 px-1 text-[10px]">
                {trainer.pendingProposalsCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="editar" className="min-h-0">
          <div className="grid h-full min-h-0 grid-cols-1 gap-6 lg:grid-cols-[220px_1fr_380px]">
            <div className="min-h-0 lg:h-full lg:overflow-y-auto">
              <ConfigTreeNav
                tree={TREE}
                selectedSection={selectedSection}
                selectedItem={selectedItem}
                expanded={expanded}
                onToggleExpanded={(key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
                onSelectLeaf={(key) => {
                  setSelectedSection(key);
                  setSelectedItem(null);
                }}
                onSelectItem={(sectionKey, itemKey) => {
                  setSelectedSection(sectionKey);
                  setSelectedItem(itemKey);
                }}
              />
            </div>

            <div className="min-h-0 lg:h-full lg:overflow-y-auto">
              <div className="mb-4 border-b pb-3">
                {itemLabel ? (
                  <>
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{sectionLabel}</p>
                    <h2 className="text-base font-semibold">{itemLabel}</h2>
                  </>
                ) : (
                  <h2 className="text-base font-semibold">{sectionLabel}</h2>
                )}
              </div>

              {selectedSection === "geral" && (
                <GeralSection draft={status.draft} onPatch={patch} agentId={agentId} onImported={refetch} />
              )}
              {selectedSection === "personalidade" && selectedItem && (
                <PersonalidadeSection draft={status.draft} onPatch={patch} item={selectedItem as PersonalidadeItemKey} />
              )}
              {selectedSection === "regras" && selectedItem && (
                <RegrasSection draft={status.draft} onPatch={patch} item={selectedItem as RegrasItemKey} />
              )}
              {selectedSection === "conhecimento" && selectedItem && (
                <ConhecimentoSection agentId={agentId} draft={status.draft} onPatch={patch} item={selectedItem as ConhecimentoItemKey} />
              )}
              {selectedSection === "playbooks" && <PlaybooksSection draft={status.draft} onPatch={patch} />}
              {selectedSection === "ferramentas" && <FerramentasSection draft={status.draft} onPatch={patch} />}
            </div>

            <div className="hidden min-h-0 lg:block lg:h-full">
              <PlaygroundPanel playground={playground} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="playground" className="min-h-0">
          <PlaygroundPanel playground={playground} />
        </TabsContent>

        <TabsContent value="historico" className="min-h-0">
          <HistoryPanel agentId={agentId} onRestored={refetch} />
        </TabsContent>

        <TabsContent value="trainer" className="min-h-0">
          <div className="grid h-full min-h-0 grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
            <div className="min-h-0 lg:h-full">
              <TrainerPanel trainer={trainer} />
            </div>
            <div className="hidden min-h-0 lg:block lg:h-full">
              <PlaygroundPanel playground={playground} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
