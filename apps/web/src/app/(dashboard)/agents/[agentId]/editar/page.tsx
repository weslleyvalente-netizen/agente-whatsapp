"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAgentConfig } from "@/components/agents/config/use-agent-config";
import { GeralSection } from "@/components/agents/config/geral-section";
import { PersonalidadeSection } from "@/components/agents/config/personalidade-section";

const SECTIONS = [
  { key: "geral", label: "Geral" },
  { key: "personalidade", label: "Personalidade" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

export default function AgentEditarPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { status, loading, patch } = useAgentConfig(agentId);
  const [activeSection, setActiveSection] = useState<SectionKey>("geral");

  if (loading || !status) return <div className="p-6">Carregando configuração...</div>;

  return (
    <div className="grid grid-cols-[200px_1fr] gap-6">
      <nav className="space-y-1">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActiveSection(s.key)}
            className={cn(
              "block w-full rounded-md px-3 py-2 text-left text-sm",
              activeSection === s.key ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div>
        {activeSection === "geral" && <GeralSection draft={status.draft} onPatch={patch} />}
        {activeSection === "personalidade" && <PersonalidadeSection draft={status.draft} onPatch={patch} />}
      </div>
    </div>
  );
}
