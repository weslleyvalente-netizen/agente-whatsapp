"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { AgentCard } from "@/components/agents/agent-card";
import { Button } from "@/components/ui/button";
import { Plus, Bot } from "lucide-react";
import type { Agent } from "@aula-agente/shared";

export default function AgentsPage() {
  const { currentOrg } = useOrganization();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) return;

    const fetchAgents = async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("agents")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });

      setAgents((data as Agent[]) || []);
      setLoading(false);
    };

    fetchAgents();
  }, [currentOrg]);

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agentes</h1>
        <Link href="/agents/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Novo Agente
          </Button>
        </Link>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Bot className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-semibold">Nenhum agente</h3>
          <p className="text-muted-foreground">Crie seu primeiro agente para comecar</p>
          <Link href="/agents/new">
            <Button className="mt-4">
              <Plus className="mr-2 h-4 w-4" />
              Criar Agente
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
