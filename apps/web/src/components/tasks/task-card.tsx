"use client";

import { Badge } from "@/components/ui/badge";
import { formatPhone, formatRelativeTime } from "@/lib/utils";
import { isHotLead, TASK_TYPE_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "@aula-agente/shared";
import type { Task } from "@aula-agente/shared";
import { Flame } from "lucide-react";

export interface TaskWithRelations extends Task {
  wa_contacts: { name: string | null; phone: string } | null;
  conversations: { last_message_at: string } | null;
}

interface TaskCardProps {
  task: TaskWithRelations;
  memberEmailsById: Record<string, string>;
  onOpenDetails: (taskId: string) => void;
}

function assigneeLabel(task: Task, memberEmailsById: Record<string, string>): string {
  if (task.assignee_type === "ai") return "Helena";
  if (task.assignee_type === "human") {
    return (task.assignee_id && memberEmailsById[task.assignee_id]) || "Responsável";
  }
  return "Sem responsável";
}

function dueLabel(task: Task): string {
  const due = new Date(`${task.due_date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const time = task.due_time ? ` ${task.due_time.slice(0, 5)}` : "";
  if (diffDays === 0) return `Vence hoje${time}`;
  if (diffDays === 1) return `Vence amanhã${time}`;
  if (diffDays < 0) return `Venceu ${due.toLocaleDateString("pt-BR")}`;
  return `Vence ${due.toLocaleDateString("pt-BR")}${time}`;
}

export function TaskCard({ task, memberEmailsById, onOpenDetails }: TaskCardProps) {
  const hot = isHotLead(task);

  return (
    <div
      className="cursor-pointer space-y-0.5 rounded-md border p-3 transition-colors hover:bg-accent/30"
      onClick={() => onOpenDetails(task.id)}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">
          {task.wa_contacts?.name || formatPhone(task.wa_contacts?.phone) || "Cliente"}
        </p>
        <div className="flex shrink-0 gap-1">
          {hot && (
            <Badge variant="tonal">
              <Flame className="size-3" />
              Quente
            </Badge>
          )}
          <Badge variant="secondary">{TASK_PRIORITY_LABELS[task.priority]}</Badge>
          <Badge variant="outline">{TASK_STATUS_LABELS[task.status]}</Badge>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{TASK_TYPE_LABELS[task.type]}</p>
      <p className="line-clamp-2 text-sm">{task.description}</p>
      <p className="text-xs text-muted-foreground">
        {assigneeLabel(task, memberEmailsById)} · {dueLabel(task)} · {formatRelativeTime(task.conversations?.last_message_at)}
      </p>
    </div>
  );
}
