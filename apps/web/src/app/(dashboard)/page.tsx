"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusLamp } from "@/components/ui/status-lamp";
import { Button, buttonVariants } from "@/components/ui/button";
import { TASK_TYPE_LABELS, type TaskType, type TaskPriority } from "@aula-agente/shared";
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";
import type { TaskWithRelations } from "@/components/tasks/task-card";

interface UrgentConversation {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  lastMessagePreview: string;
  lastMessageAt: string;
}

interface PendingHandoff {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  motivo: string | null;
  resumo: string | null;
  urgencia: string | null;
  handedAt: string;
  waitMinutes: number;
  unanswered: boolean;
}

interface DashboardSummary {
  conversationsLast7d: number;
  inProgress: number;
  avgResponseSeconds: number | null;
  needsAttention: number;
  urgentConversations: UrgentConversation[];
  pendingHandoffs: PendingHandoff[];
}

interface TodayItem {
  taskId: string;
  type: string;
  title: string;
  description: string;
  reason: string | null;
  priority: string;
  dueDate: string;
  contactName: string | null;
  contactPhone: string;
  conversationId: string | null;
  opportunityId: string | null;
  score: number;
}

function formatWaitMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}min`;
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
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (minutes === 0) return `${secs}s`;
  return `${minutes}m ${secs}s`;
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
  const [error, setError] = useState<string | null>(null);

  // Fase 2, item 4 — visão "Hoje": top-10 por score, à parte do resumo
  // acima (endpoints diferentes, não precisa bloquear um no outro).
  const [today, setToday] = useState<TodayItem[] | null>(null);
  const [actingTaskId, setActingTaskId] = useState<string | null>(null);
  const [followupItem, setFollowupItem] = useState<TodayItem | null>(null);

  const fetchToday = () => {
    if (!currentOrg) return;
    apiFetch(`/organizations/${currentOrg.id}/dashboard/today`)
      .then((data) => setToday(data.items))
      .catch(() => setToday([]));
  };

  useEffect(() => {
    if (!currentOrg) return;
    apiFetch(`/organizations/${currentOrg.id}/dashboard/summary`)
      .then(setSummary)
      .catch(() => setError("Não foi possível carregar o resumo."))
      .finally(() => setLoading(false));
    fetchToday();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg]);

  const handleCompleteToday = async (taskId: string) => {
    setActingTaskId(taskId);
    try {
      await apiFetch(`/tasks/${taskId}/complete`, { method: "POST" });
      setToday((prev) => prev?.filter((t) => t.taskId !== taskId) ?? prev);
    } catch {
      // best-effort UI action — nothing else to show, item just stays put
    } finally {
      setActingTaskId(null);
    }
  };

  const handlePostponeToday = async (taskId: string, days: number) => {
    setActingTaskId(taskId);
    try {
      const dueDate = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
      await apiFetch(`/tasks/${taskId}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ due_date: dueDate }),
      });
      setToday((prev) => prev?.filter((t) => t.taskId !== taskId) ?? prev);
    } catch {
      // best-effort UI action
    } finally {
      setActingTaskId(null);
    }
  };

  // The "Hoje" widget's item shape (TodayItem) has less than a full Task —
  // TaskDetailPanel re-fetches everything real (customer/conversation/
  // qualification) via /tasks/:id/details itself; the `task` prop here is
  // only read for header labels (type/priority) and the follow-up
  // eligibility check, so the rest is filled with harmless placeholders.
  function toPlaceholderTask(item: TodayItem): TaskWithRelations {
    return {
      id: item.taskId,
      organization_id: currentOrg?.id ?? "",
      contact_id: "",
      conversation_id: item.conversationId,
      opportunity_id: item.opportunityId,
      assignee_type: null,
      assignee_id: null,
      type: item.type as TaskType,
      title: item.description,
      description: item.description,
      ai_summary: null,
      reason: item.reason,
      priority: item.priority as TaskPriority,
      status: "pending",
      due_date: item.dueDate,
      due_time: null,
      created_by_type: "ai",
      created_by_id: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      consolidated_pendencies: [],
      followup_suggested_message: null,
      followup_suggestion_generated_at: null,
      followup_regeneration_count: 0,
      wa_contacts: { name: item.contactName, phone: item.contactPhone },
      conversations: null,
    } as unknown as TaskWithRelations;
  }

  if (loading) return <div>Carregando...</div>;
  if (error || !summary) return <div>Nao foi possivel carregar o resumo.</div>;

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
          <CardTitle>Handoffs aguardando</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.pendingHandoffs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum handoff aguardando resposta.</p>
          ) : (
            <div className="divide-y divide-border">
              {summary.pendingHandoffs.map((h) => (
                <Link
                  key={h.conversationId}
                  href={`/inbox?id=${h.conversationId}`}
                  className="flex items-center gap-3 py-3 transition-colors hover:bg-accent/50"
                >
                  <Avatar>
                    <AvatarFallback>{(h.contactName || h.contactPhone || "?")[0].toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{h.contactName || h.contactPhone || "?"}</p>
                    <p className="truncate text-sm text-muted-foreground">{h.resumo || h.motivo || "—"}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="tabular-data text-xs text-muted-foreground">
                      esperando há {formatWaitMinutes(h.waitMinutes)}
                    </span>
                    {h.unanswered && (
                      <Badge variant="destructive" className="flex items-center gap-1">
                        <StatusLamp tone="rust" pulse /> Sem resposta
                      </Badge>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hoje</CardTitle>
        </CardHeader>
        <CardContent>
          {today === null ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : today.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma tarefa em aberto priorizada por hoje.</p>
          ) : (
            <div className="divide-y divide-border">
              {today.map((item) => (
                <div key={item.taskId} className="flex items-center gap-3 py-3">
                  <Avatar>
                    <AvatarFallback>
                      {(item.contactName || item.contactPhone || "?")[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {item.contactName || item.contactPhone || "?"}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {TASK_TYPE_LABELS[item.type as keyof typeof TASK_TYPE_LABELS] ?? item.type}
                      </span>
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{item.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className="tabular-data">
                      score {Math.round(item.score)}
                    </Badge>
                    {item.conversationId && (
                      <Link
                        href={`/inbox?id=${item.conversationId}`}
                        className={buttonVariants({ size: "sm", variant: "outline" })}
                      >
                        Abrir
                      </Link>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actingTaskId === item.taskId}
                      onClick={() => setFollowupItem(item)}
                    >
                      Enviar
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actingTaskId === item.taskId}
                      onClick={() => handlePostponeToday(item.taskId, 1)}
                    >
                      Adiar
                    </Button>
                    <Button
                      size="sm"
                      disabled={actingTaskId === item.taskId}
                      onClick={() => handleCompleteToday(item.taskId)}
                    >
                      Concluir
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
                      {(c.contactName || c.contactPhone || "?")[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.contactName || c.contactPhone || "?"}</p>
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

      {followupItem && currentOrg && (
        <TaskDetailPanel
          task={toPlaceholderTask(followupItem)}
          taskId={followupItem.taskId}
          organizationId={currentOrg.id}
          onClose={() => setFollowupItem(null)}
          onTaskChanged={() => {
            fetchToday();
            setFollowupItem(null);
          }}
        />
      )}
    </div>
  );
}
