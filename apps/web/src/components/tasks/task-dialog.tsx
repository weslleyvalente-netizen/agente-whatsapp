"use client";

import { useState, useEffect, type ReactElement, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TASK_TYPES, TASK_TYPE_LABELS, TASK_PRIORITIES, TASK_PRIORITY_LABELS } from "@aula-agente/shared";
import type { Task, TaskType, TaskPriority } from "@aula-agente/shared";

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

interface MemberOption {
  user_id: string;
  email: string;
  role: string;
}

interface TaskDialogProps {
  organizationId: string;
  presetContact?: ContactOption | null;
  presetConversationId?: string | null;
  task?: Task | null;
  triggerButton: ReactElement;
  triggerLabel: ReactNode;
  onSaved: () => void;
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

export function TaskDialog({
  organizationId,
  presetContact = null,
  presetConversationId = null,
  task = null,
  triggerButton,
  triggerLabel,
  onSaved,
}: TaskDialogProps) {
  const isEditing = !!task;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactOption[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactOption | null>(presetContact);

  const [members, setMembers] = useState<MemberOption[]>([]);

  const [type, setType] = useState<TaskType>(task?.type ?? "return_customer");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "normal");
  const [dueDate, setDueDate] = useState(task?.due_date ?? todayISODate());
  const [dueTime, setDueTime] = useState(task?.due_time ?? "");
  const [assigneeValue, setAssigneeValue] = useState(
    task?.assignee_type === "human"
      ? `human:${task.assignee_id}`
      : task?.assignee_type === "ai"
        ? "ai"
        : "none"
  );

  useEffect(() => {
    if (!open) return;
    apiFetch(`/organizations/${organizationId}/members/display`)
      .then((data) => setMembers(data))
      .catch(() => setMembers([]));
  }, [open, organizationId]);

  useEffect(() => {
    if (isEditing || presetContact || !contactQuery.trim() || contactQuery.trim().length < 2) {
      setContactResults([]);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    const timeout = setTimeout(async () => {
      const { data } = await supabase
        .from("wa_contacts")
        .select("id, name, phone")
        .eq("organization_id", organizationId)
        .or(`name.ilike.%${contactQuery}%,phone.ilike.%${contactQuery}%`)
        .limit(8);
      if (!cancelled) {
        setContactResults(data || []);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [contactQuery, organizationId, presetContact, isEditing]);

  const handleSubmit = async () => {
    if (!selectedContact && !isEditing) {
      setError("Selecione um cliente");
      return;
    }
    setSaving(true);
    setError(null);

    const assigneeType = assigneeValue === "none" ? null : assigneeValue === "ai" ? "ai" : "human";
    const assigneeId = assigneeType === "human" ? assigneeValue.replace("human:", "") : null;

    try {
      if (isEditing && task) {
        await apiFetch(`/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            type,
            description,
            priority,
            due_date: dueDate,
            due_time: dueTime || null,
            assignee_type: assigneeType,
            assignee_id: assigneeId,
          }),
        });
      } else {
        await apiFetch(`/organizations/${organizationId}/tasks`, {
          method: "POST",
          body: JSON.stringify({
            contact_id: selectedContact!.id,
            conversation_id: presetConversationId,
            type,
            description,
            priority,
            due_date: dueDate,
            due_time: dueTime || null,
            assignee_type: assigneeType,
            assignee_id: assigneeId,
          }),
        });
      }
      if (!isEditing) {
        setSelectedContact(presetContact);
        setContactQuery("");
        setContactResults([]);
        setType("return_customer");
        setDescription("");
        setPriority("normal");
        setDueDate(todayISODate());
        setDueTime("");
        setAssigneeValue("none");
      }
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar tarefa");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={triggerButton}>{triggerLabel}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Editar tarefa" : "Nova tarefa"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Cliente</Label>
            {isEditing ? (
              <div className="text-sm text-muted-foreground">
                {selectedContact ? (
                  <span>
                    {selectedContact.name || "Sem nome"} — {selectedContact.phone}
                  </span>
                ) : (
                  <span>Cliente da tarefa</span>
                )}
              </div>
            ) : selectedContact ? (
              <div className="flex items-center justify-between text-sm">
                <span>
                  {selectedContact.name || "Sem nome"} — {selectedContact.phone}
                </span>
                {!presetContact && (
                  <Button variant="link" size="sm" onClick={() => setSelectedContact(null)}>
                    trocar
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <Input
                  placeholder="Buscar por nome ou telefone..."
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                />
                {contactResults.length > 0 && (
                  <div className="rounded-md border">
                    {contactResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                        onClick={() => {
                          setSelectedContact(c);
                          setContactResults([]);
                        }}
                      >
                        {c.name || "Sem nome"} — {c.phone}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Tipo</Label>
            <Select value={type} onValueChange={(v) => v && setType(v as TaskType)}>
              <SelectTrigger>
                <SelectValue>{(value: TaskType) => TASK_TYPE_LABELS[value] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TASK_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TASK_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Descrição</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Data</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Horário (opcional)</Label>
              <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Prioridade</Label>
              <Select value={priority} onValueChange={(v) => v && setPriority(v as TaskPriority)}>
                <SelectTrigger>
                  <SelectValue>{(value: TaskPriority) => TASK_PRIORITY_LABELS[value] ?? value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TASK_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {TASK_PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Responsável</Label>
              <Select value={assigneeValue} onValueChange={(v) => v && setAssigneeValue(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem responsável</SelectItem>
                  <SelectItem value="ai">Helena</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={`human:${m.user_id}`}>
                      {m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={handleSubmit} disabled={saving} className="w-full">
            {saving ? "Salvando..." : isEditing ? "Salvar alterações" : "Criar tarefa"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
