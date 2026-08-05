"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Task } from "@aula-agente/shared";

export function RescheduleDialog({ task, onRescheduled }: { task: Task; onRescheduled: () => void }) {
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
