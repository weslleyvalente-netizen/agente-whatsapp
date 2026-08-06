"use client";

import { sortTasksForToday, isHotLead, type TaskBucket } from "@aula-agente/shared";
import { TaskCard, type TaskWithRelations } from "./task-card";

interface TaskListProps {
  tasks: TaskWithRelations[];
  bucket: TaskBucket;
  organizationId: string;
  memberEmailsById: Record<string, string>;
  onRefresh: () => void;
}

export function TaskList({ tasks, bucket, organizationId, memberEmailsById, onRefresh }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma tarefa aqui.</p>;
  }

  if (bucket !== "today") {
    return (
      <div className="space-y-3">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            organizationId={organizationId}
            memberEmailsById={memberEmailsById}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    );
  }

  const sortable = tasks.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    due_time: t.due_time,
    priority: t.priority,
    lastMessageAt: t.conversations?.last_message_at ?? null,
  }));
  const sortedIds = sortTasksForToday(sortable, Date.now()).map((t) => t.id);
  const orderedTasks = sortedIds.map((id) => tasks.find((t) => t.id === id)!);

  const hot = orderedTasks.filter((t) => isHotLead(t));
  const warm = orderedTasks.filter((t) => !isHotLead(t));

  return (
    <div className="space-y-6">
      {hot.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">🔥 Leads quentes</h3>
          {hot.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              organizationId={organizationId}
              memberEmailsById={memberEmailsById}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
      {warm.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">🟡 Follow-ups</h3>
          {warm.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              organizationId={organizationId}
              memberEmailsById={memberEmailsById}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
