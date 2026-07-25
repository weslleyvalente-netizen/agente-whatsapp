"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Task, TaskEvent } from "@aula-agente/shared";

interface TaskWithEvents extends Task {
  task_events: TaskEvent[];
}

const EVENT_LABELS: Record<string, string> = {
  created: "criada",
  updated: "atualizada",
  rescheduled: "reagendada",
  completed: "concluída",
  cancelled: "cancelada",
  assigned: "reatribuída",
};

interface TaskHistoryPanelProps {
  contactId: string;
}

export function TaskHistoryPanel({ contactId }: TaskHistoryPanelProps) {
  const [tasks, setTasks] = useState<TaskWithEvents[]>([]);

  const fetchTasks = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("tasks")
      .select("*, task_events(*)")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false });
    setTasks((data as TaskWithEvents[]) || []);
  }, [contactId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const events = tasks
    .flatMap((task) => task.task_events.map((event) => ({ ...event, taskTitle: task.title })))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">Nenhuma tarefa registrada ainda.</p>;
  }

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <div key={event.id} className="rounded-md border p-2 text-xs">
          <p>
            {event.taskTitle} — {EVENT_LABELS[event.event_type] ?? event.event_type}
          </p>
          <p className="mt-1 text-muted-foreground">
            {new Date(event.created_at).toLocaleString("pt-BR")} ·{" "}
            {event.created_by_type === "ai" ? "Helena" : "Equipe"}
          </p>
        </div>
      ))}
    </div>
  );
}
