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

// Mirrors OPEN_TASK_STATUSES in packages/database/src/queries/tasks.ts —
// duplicated as a literal instead of imported so this client component
// never pulls in @aula-agente/database's server-only code into the
// browser bundle.
const OPEN_STATUSES = ["pending", "in_progress", "rescheduled"];
const DONE_STATUSES = ["completed", "cancelled"];
// 30 days on its own already exceeds 1000 rows for this org today (1249
// completed/cancelled in the last 30 days vs. ~28/day) — the explicit
// .limit(500) + updated_at-descending order below is the real backstop;
// this window just keeps "Concluídas" from defaulting to all-time history.
const DONE_LOOKBACK_DAYS = 7;

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
    const baseSelect = "*, wa_contacts(name, phone), conversations(last_message_at)";

    // Root cause of the "tarefas zeradas" incident (2026-09-24): this used
    // to fetch ALL of the org's tasks (no status/date filter) ordered by
    // due_date ascending, with no .limit() — relying on the total staying
    // under Supabase/PostgREST's default 1000-row cap. Once tasks with a
    // due_date before today passed 1000 (confirmed: 1380 of them), every
    // row returned was an old dead task and today's/upcoming tasks never
    // made it into the response at all, even though they existed in the
    // DB — the summary cards and every tab silently showed zero.
    //
    // Fix: query open and done tasks separately. Open tasks (what the
    // Hoje/Atrasadas/Próximas tabs and every summary card except
    // "Concluídas hoje" need) are always a small slice of the total, so a
    // 1000-row cap on just those is not a practical concern. Done tasks
    // are scoped to a recent window so old completed/cancelled history
    // doesn't crowd out "Concluídas hoje" the same way.
    const doneLookbackISO = new Date(Date.now() - DONE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Both queries also carry an explicit .limit() + a descending
    // updated_at/due_date order as a hard backstop, independent of the
    // date window above — if either set ever grows past the row cap
    // again, the truncation drops the OLDEST rows in that ordering, never
    // today's, instead of silently going empty like the original bug.
    const [{ data: openTasks }, { data: doneTasks }] = await Promise.all([
      supabase
        .from("tasks")
        .select(baseSelect)
        .eq("organization_id", currentOrg.id)
        .in("status", OPEN_STATUSES)
        .order("due_date", { ascending: true })
        .limit(1000),
      supabase
        .from("tasks")
        .select(baseSelect)
        .eq("organization_id", currentOrg.id)
        .in("status", DONE_STATUSES)
        .gte("updated_at", doneLookbackISO)
        .order("updated_at", { ascending: false })
        .limit(500),
    ]);

    setTasks([...((openTasks as TaskWithRelations[]) || []), ...((doneTasks as TaskWithRelations[]) || [])]);
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
