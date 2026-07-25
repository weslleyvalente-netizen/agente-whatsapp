import type { SupabaseClient } from "@aula-agente/database";
import { updateTask, addTaskEvent } from "@aula-agente/database";
import { TASK_TYPE_LABELS } from "@aula-agente/shared";
import type { Task, TaskType, TaskPriority, TaskAssigneeType } from "@aula-agente/shared";

interface Actor {
  type: "human" | "ai";
  id: string | null;
}

export async function completeTask(db: SupabaseClient, taskId: string, actor: Actor): Promise<Task> {
  const task = await updateTask(db, taskId, { status: "completed", completed_at: new Date().toISOString() });
  await addTaskEvent(db, {
    task_id: taskId,
    organization_id: task.organization_id,
    event_type: "completed",
    note: null,
    created_by_type: actor.type,
    created_by_id: actor.id,
  });
  return task;
}

export async function cancelTask(
  db: SupabaseClient,
  taskId: string,
  actor: Actor,
  note: string | null = null
): Promise<Task> {
  const task = await updateTask(db, taskId, { status: "cancelled" });
  await addTaskEvent(db, {
    task_id: taskId,
    organization_id: task.organization_id,
    event_type: "cancelled",
    note,
    created_by_type: actor.type,
    created_by_id: actor.id,
  });
  return task;
}

export async function rescheduleTask(
  db: SupabaseClient,
  taskId: string,
  actor: Actor,
  dueDate: string,
  dueTime: string | null = null
): Promise<Task> {
  const task = await updateTask(db, taskId, { status: "rescheduled", due_date: dueDate, due_time: dueTime });
  await addTaskEvent(db, {
    task_id: taskId,
    organization_id: task.organization_id,
    event_type: "rescheduled",
    note: `Reagendada para ${dueDate}`,
    created_by_type: actor.type,
    created_by_id: actor.id,
  });
  return task;
}

export interface UpdateTaskFieldsInput {
  type?: TaskType;
  description?: string;
  reason?: string | null;
  priority?: TaskPriority;
  due_date?: string;
  due_time?: string | null;
  assignee_type?: TaskAssigneeType | null;
  assignee_id?: string | null;
}

export async function updateTaskFields(
  db: SupabaseClient,
  taskId: string,
  updates: UpdateTaskFieldsInput,
  actorUserId: string
): Promise<Task> {
  const patch: Partial<Task> = { ...updates };
  if (updates.type) patch.title = TASK_TYPE_LABELS[updates.type];

  const task = await updateTask(db, taskId, patch);
  await addTaskEvent(db, {
    task_id: taskId,
    organization_id: task.organization_id,
    event_type: "updated",
    note: null,
    created_by_type: "human",
    created_by_id: actorUserId,
  });
  return task;
}

export interface MemberDisplay {
  user_id: string;
  email: string;
  role: string;
}

export async function getOrganizationMembersDisplay(
  db: SupabaseClient,
  organizationId: string
): Promise<MemberDisplay[]> {
  const { data: members, error } = await db
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", organizationId);
  if (error) throw error;

  return Promise.all(
    (members || []).map(async (member: { user_id: string; role: string }): Promise<MemberDisplay> => {
      const { data, error: userError } = await db.auth.admin.getUserById(member.user_id);
      if (userError || !data.user) {
        return { user_id: member.user_id, email: member.user_id, role: member.role };
      }
      return { user_id: member.user_id, email: data.user.email ?? member.user_id, role: member.role };
    })
  );
}
