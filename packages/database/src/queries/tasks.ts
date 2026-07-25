import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task, TaskEvent, TaskType, TaskCreatedByType, TaskAssigneeType } from "@aula-agente/shared";
import { TASK_TYPE_LABELS, OPPORTUNITY_SIGNAL_TASK_TYPES, resolveTaskDedupAction } from "@aula-agente/shared";

const OPEN_TASK_STATUSES = ["pending", "in_progress", "rescheduled"];

export async function createTask(
  client: SupabaseClient,
  task: Omit<Task, "id" | "created_at" | "updated_at" | "completed_at">
) {
  const { data, error } = await client.from("tasks").insert(task).select().single();
  if (error) throw error;
  return data as Task;
}

export async function updateTask(client: SupabaseClient, id: string, updates: Partial<Task>) {
  const { data, error } = await client.from("tasks").update(updates).eq("id", id).select().single();
  if (error) throw error;
  return data as Task;
}

export async function getTaskById(client: SupabaseClient, id: string) {
  const { data, error } = await client.from("tasks").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Task;
}

export async function getOpenTaskByContactAndType(
  client: SupabaseClient,
  organizationId: string,
  contactId: string,
  type: TaskType
) {
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("type", type)
    .in("status", OPEN_TASK_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Task | null;
}

export async function getOpenTaskByConversation(
  client: SupabaseClient,
  organizationId: string,
  conversationId: string
) {
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .in("status", OPEN_TASK_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Task | null;
}

export async function getLatestTaskByConversationAndType(
  client: SupabaseClient,
  organizationId: string,
  conversationId: string,
  type: TaskType
) {
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("type", type)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Task | null;
}

export async function hasOpportunitySignalTask(
  client: SupabaseClient,
  organizationId: string,
  contactId: string
) {
  const { data, error } = await client
    .from("tasks")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("type", OPPORTUNITY_SIGNAL_TASK_TYPES)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function getTasksByContact(client: SupabaseClient, contactId: string) {
  const { data, error } = await client
    .from("tasks")
    .select("*, task_events(*)")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function addTaskEvent(client: SupabaseClient, event: Omit<TaskEvent, "id" | "created_at">) {
  const { data, error } = await client.from("task_events").insert(event).select().single();
  if (error) throw error;
  return data as TaskEvent;
}

export async function getTaskEvents(client: SupabaseClient, taskId: string) {
  const { data, error } = await client
    .from("task_events")
    .select("*")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as TaskEvent[];
}

export interface CreateTaskWithDedupInput {
  organization_id: string;
  contact_id: string;
  conversation_id: string | null;
  type: TaskType;
  description: string;
  reason: string | null;
  priority: Task["priority"];
  due_date: string;
  due_time?: string | null;
  created_by_type: TaskCreatedByType;
  created_by_id: string | null;
  assignee_type?: TaskAssigneeType | null;
  assignee_id?: string | null;
}

export async function createTaskWithDedup(
  client: SupabaseClient,
  input: CreateTaskWithDedupInput
): Promise<{ task: Task; wasUpdated: boolean }> {
  const existing = await getOpenTaskByContactAndType(
    client,
    input.organization_id,
    input.contact_id,
    input.type
  );
  const decision = resolveTaskDedupAction(existing, {
    due_date: input.due_date,
    description: input.description,
    reason: input.reason,
  });

  if (decision.action === "update") {
    const task = await updateTask(client, decision.taskId, decision.changes);
    await addTaskEvent(client, {
      task_id: task.id,
      organization_id: input.organization_id,
      event_type: "updated",
      note: `Tarefa semelhante já aberta — atualizada para ${input.due_date}.`,
      created_by_type: input.created_by_type,
      created_by_id: input.created_by_id,
    });
    return { task, wasUpdated: true };
  }

  const assigneeType: TaskAssigneeType | null =
    input.assignee_type !== undefined ? input.assignee_type : input.created_by_type === "ai" ? "ai" : null;
  const assigneeId = assigneeType === "human" ? input.assignee_id ?? null : null;

  const task = await createTask(client, {
    organization_id: input.organization_id,
    contact_id: input.contact_id,
    conversation_id: input.conversation_id,
    assignee_type: assigneeType,
    assignee_id: assigneeId,
    type: input.type,
    title: TASK_TYPE_LABELS[input.type],
    description: input.description,
    ai_summary: null,
    reason: input.reason,
    priority: input.priority,
    status: "pending",
    due_date: input.due_date,
    due_time: input.due_time ?? null,
    created_by_type: input.created_by_type,
    created_by_id: input.created_by_id,
  });

  await addTaskEvent(client, {
    task_id: task.id,
    organization_id: input.organization_id,
    event_type: "created",
    note: null,
    created_by_type: input.created_by_type,
    created_by_id: input.created_by_id,
  });

  return { task, wasUpdated: false };
}
