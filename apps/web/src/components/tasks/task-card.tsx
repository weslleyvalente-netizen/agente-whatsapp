"use client";

import { Badge } from "@/components/ui/badge";
import { formatPhone, formatRelativeTime, cn } from "@/lib/utils";
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
  isSelected: boolean;
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
  const dateStr = due.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  if (diffDays === 0) return `Vence hoje${time}`;
  if (diffDays === 1) return `Vence amanhã${time}`;
  if (diffDays < 0) return `Venceu ${dateStr}`;
  return `Vence ${dateStr}${time}`;
}

export function TaskCard({ task, memberEmailsById, isSelected, onOpenDetails }: TaskCardProps) {
  const hot = isHotLead(task);

  return (
    <div
      className={cn(
        "relative cursor-pointer space-y-0.5 px-3 py-2 transition-colors",
        isSelected ? "bg-accent/40" : "hover:bg-accent/30"
      )}
      onClick={() => onOpenDetails(task.id)}
    >
      {isSelected && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="min-w-0 truncate text-sm font-medium">
          {task.wa_contacts?.name || formatPhone(task.wa_contacts?.phone) || "Cliente"}
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">{TASK_TYPE_LABELS[task.type]}</span>
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
      <p className="line-clamp-2 text-sm">{task.description}</p>
      <p className="text-xs text-muted-foreground">
        {assigneeLabel(task, memberEmailsById)} · {dueLabel(task)} · {formatRelativeTime(task.conversations?.last_message_at)}
      </p>
    </div>
  );
}
