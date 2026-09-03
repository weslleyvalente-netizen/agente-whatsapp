"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import {
  resolveTaskBucket,
  computeTaskSummary,
  toISODateInTimeZone,
  type TaskBucket,
} from "@aula-agente/shared";
import { TaskList } from "@/components/tasks/task-list";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskWithRelations } from "@/components/tasks/task-card";

const TABS: Array<{ id: TaskBucket; label: string }> = [
  { id: "today", label: "Hoje" },
  { id: "overdue", label: "Atrasadas" },
  { id: "upcoming", label: "Próximas" },
  { id: "done", label: "Concluídas" },
];

export default function TasksPage() {
  const { currentOrg } = useOrganization();
  const [tasks, setTasks] = useState<TaskWithRelations[]>([]);
  const [memberEmailsById, setMemberEmailsById] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<TaskBucket>("today");
  const [loading, setLoading] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    if (!currentOrg) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("tasks")
      .select("*, wa_contacts(name, phone), conversations(last_message_at)")
      .eq("organization_id", currentOrg.id)
      .order("due_date", { ascending: true });
    setTasks((data as TaskWithRelations[]) || []);
    setLoading(false);
  }, [currentOrg]);

  const fetchMembers = useCallback(async () => {
    if (!currentOrg) return;
    try {
      const members = await apiFetch(`/organizations/${currentOrg.id}/members/display`);
      const map: Record<string, string> = {};
      for (const m of members) map[m.user_id] = m.email;
      setMemberEmailsById(map);
    } catch {
      setMemberEmailsById({});
    }
  }, [currentOrg]);

  useEffect(() => {
    fetchTasks();
    fetchMembers();
  }, [fetchTasks, fetchMembers]);

  useEffect(() => {
    const interval = setInterval(fetchTasks, 30_000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  const handleTabChange = (nextTab: TaskBucket) => {
    setTab(nextTab);
    fetchTasks();
  };

  const today = toISODateInTimeZone(new Date());

  const bucketed = useMemo(() => {
    const groups: Record<TaskBucket, TaskWithRelations[]> = { today: [], overdue: [], upcoming: [], done: [] };
    for (const task of tasks) {
      groups[resolveTaskBucket(task, today)].push(task);
    }
    return groups;
  }, [tasks, today]);

  const summary = useMemo(() => computeTaskSummary(tasks, today), [tasks, today]);

  if (loading || !currentOrg) return <div>Carregando...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tarefas</h1>
        <TaskDialog
          organizationId={currentOrg.id}
          triggerButton={<Button />}
          triggerLabel={
            <>
              <Plus className="mr-2 h-4 w-4" />
              Nova tarefa
            </>
          }
          onSaved={fetchTasks}
        />
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">Tarefas hoje</p>
          <p className="text-2xl font-bold">{summary.today}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">Atrasadas</p>
          <p className="text-2xl font-bold">{summary.overdue}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">Concluídas hoje</p>
          <p className="text-2xl font-bold">{summary.completedToday}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">Leads quentes com tarefa aberta</p>
          <p className="text-2xl font-bold">{summary.hotOpenLeads}</p>
        </div>
      </div>

      <div className="flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => handleTabChange(t.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              tab === t.id
                ? "border-transparent bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground hover:bg-accent"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <TaskList
        tasks={bucketed[tab]}
        bucket={tab}
        memberEmailsById={memberEmailsById}
        selectedTaskId={selectedTaskId}
        onOpenDetails={setSelectedTaskId}
      />

      {selectedTaskId && (() => {
        const selectedTask = tasks.find((t) => t.id === selectedTaskId);
        if (!selectedTask) return null;
        return (
          <TaskDetailPanel
            task={selectedTask}
            taskId={selectedTaskId}
            organizationId={currentOrg.id}
            onClose={() => setSelectedTaskId(null)}
            onTaskChanged={() => {
              fetchTasks();
              setSelectedTaskId(null);
            }}
          />
        );
      })()}
    </div>
  );
}
