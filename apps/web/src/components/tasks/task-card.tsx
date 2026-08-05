"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPhone } from "@/lib/utils";
import { isHotLead, TASK_TYPE_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "@aula-agente/shared";
import type { Task } from "@aula-agente/shared";
import { TaskDialog } from "./task-dialog";

export interface TaskWithRelations extends Task {
  wa_contacts: { name: string | null; phone: string } | null;
  conversations: { last_message_at: string } | null;
}

interface TaskCardProps {
  task: TaskWithRelations;
  organizationId: string;
  memberEmailsById: Record<string, string>;
  onRefresh: () => void;
  onOpenDetails: (taskId: string) => void;
}

function assigneeLabel(task: Task, memberEmailsById: Record<string, string>): string {
  if (task.assignee_type === "ai") return "Helena";
  if (task.assignee_type === "human") {
    return (task.assignee_id && memberEmailsById[task.assignee_id]) || "Responsável";
  }
  return "Sem responsável";
}

function RescheduleDialog({ task, onRescheduled }: { task: Task; onRescheduled: () => void }) {
  const [open, setOpen] = useState(false);
  const [dueDate, setDueDate] = useState(task.due_date);
  const [dueTime, setDueTime] = useState(task.due_time ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await apiFetch(`/tasks/${task.id}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ due_date: dueDate, due_time: dueTime || null }),
      });
      setOpen(false);
      onRescheduled();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao reagendar tarefa");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Reagendar</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reagendar tarefa</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nova data</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Novo horário (opcional)</Label>
            <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
          </div>
          <Button onClick={handleSubmit} disabled={saving} className="w-full">
            {saving ? "Salvando..." : "Confirmar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TaskCard({ task, organizationId, memberEmailsById, onRefresh, onOpenDetails }: TaskCardProps) {
  const router = useRouter();
  const hot = isHotLead(task);
  const isOpen = task.status !== "completed" && task.status !== "cancelled";

  const handleComplete = async () => {
    try {
      await apiFetch(`/tasks/${task.id}/complete`, { method: "POST" });
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao concluir tarefa");
    }
  };

  const handleCancel = async () => {
    if (!confirm("Cancelar esta tarefa?")) return;
    try {
      await apiFetch(`/tasks/${task.id}/cancel`, { method: "POST", body: JSON.stringify({}) });
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao cancelar tarefa");
    }
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-4">
      <div className="min-w-0 cursor-pointer space-y-1" onClick={() => onOpenDetails(task.id)}>
        <p className="font-medium">
          {hot && "🔥 "}
          {task.wa_contacts?.name || formatPhone(task.wa_contacts?.phone) || "Cliente"}
        </p>
        <p className="text-xs text-muted-foreground">{TASK_TYPE_LABELS[task.type]}</p>
        <p className="text-sm">{task.description}</p>
        <p className="text-xs text-muted-foreground">
          {new Date(`${task.due_date}T00:00:00`).toLocaleDateString("pt-BR")}
          {task.due_time && ` - ${task.due_time.slice(0, 5)}`}
          {" · "}Responsável: {assigneeLabel(task, memberEmailsById)}
        </p>
        <div className="flex gap-2">
          <Badge variant="secondary">{TASK_PRIORITY_LABELS[task.priority]}</Badge>
          <Badge variant="outline">{TASK_STATUS_LABELS[task.status]}</Badge>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2">
        {task.conversation_id && (
          <Button variant="outline" size="sm" onClick={() => router.push(`/inbox?id=${task.conversation_id}`)}>
            Abrir conversa
          </Button>
        )}
        {isOpen && (
          <>
            <Button size="sm" onClick={handleComplete}>
              Concluir
            </Button>
            <RescheduleDialog task={task} onRescheduled={onRefresh} />
            <TaskDialog
              organizationId={organizationId}
              task={task}
              presetContact={{ id: task.contact_id, name: task.wa_contacts?.name ?? null, phone: task.wa_contacts?.phone ?? "" }}
              triggerButton={<Button variant="outline" size="sm" />}
              triggerLabel="Editar"
              onSaved={onRefresh}
            />
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              Cancelar
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
