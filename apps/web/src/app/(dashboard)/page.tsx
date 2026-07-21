"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusLamp } from "@/components/ui/status-lamp";

interface UrgentConversation {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  lastMessagePreview: string;
  lastMessageAt: string;
}

interface DashboardSummary {
  conversationsLast7d: number;
  inProgress: number;
  avgResponseSeconds: number | null;
  needsAttention: number;
  urgentConversations: UrgentConversation[];
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return { text: "Bom dia", icon: "☀️" };
  if (hour < 18) return { text: "Boa tarde", icon: "☀️" };
  return { text: "Boa noite", icon: "🌙" };
}

function formatFullDate() {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
}

function formatResponseTime(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)}m`;
}

function formatRelativeTime(iso: string) {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `há ${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  return `há ${diffD} dia${diffD > 1 ? "s" : ""}`;
}

export default function HomePage() {
  const { currentOrg } = useOrganization();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) return;
    apiFetch(`/organizations/${currentOrg.id}/dashboard/summary`)
      .then(setSummary)
      .finally(() => setLoading(false));
  }, [currentOrg]);

  if (loading) return <div>Carregando...</div>;
  if (!summary) return <div>Nao foi possivel carregar o resumo.</div>;

  const { text, icon } = greeting();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{text}, {icon}</h1>
        <p className="text-sm text-muted-foreground">
          Aqui está o que precisa da sua atenção hoje, {formatFullDate()}.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Conversas (7 dias)</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">
            {summary.conversationsLast7d}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Em andamento</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">
            {summary.inProgress}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Tempo de resposta</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">
            {formatResponseTime(summary.avgResponseSeconds)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Precisam de atenção</p>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-2xl font-medium">
            <span className="tabular-data">{summary.needsAttention}</span>
            {summary.needsAttention > 0 && <StatusLamp tone="rust" pulse />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tarefas urgentes</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.urgentConversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma conversa esperando atenção.</p>
          ) : (
            <div className="divide-y divide-border">
              {summary.urgentConversations.map((c) => (
                <Link
                  key={c.conversationId}
                  href={`/inbox?id=${c.conversationId}`}
                  className="flex items-center gap-3 py-3 transition-colors hover:bg-accent/50"
                >
                  <Avatar>
                    <AvatarFallback>
                      {(c.contactName || c.contactPhone)[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.contactName || c.contactPhone}</p>
                    <p className="truncate text-sm text-muted-foreground">{c.lastMessagePreview}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="tabular-data text-xs text-muted-foreground">
                      {formatRelativeTime(c.lastMessageAt)}
                    </span>
                    <Badge variant="destructive">Urgente</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
