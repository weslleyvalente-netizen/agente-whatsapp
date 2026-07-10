"use client";

import Link from "next/link";
import type { Agent } from "@aula-agente/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot } from "lucide-react";

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
  return (
    <Link href={`/agents/${agent.id}`}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader className="flex flex-row items-center gap-3 pb-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Bot className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">{agent.name}</CardTitle>
            <p className="text-sm text-muted-foreground">{agent.description || "Sem descricao"}</p>
          </div>
          <Badge variant={agent.is_active ? "default" : "secondary"}>
            {agent.is_active ? "Ativo" : "Inativo"}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>Modelo: {agent.model}</span>
            <span>Provider: {agent.provider}</span>
            <span>Temp: {agent.temperature}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
