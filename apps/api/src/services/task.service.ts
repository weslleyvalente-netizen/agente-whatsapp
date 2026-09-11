import type { SupabaseClient } from "@aula-agente/database";
import { updateTask, addTaskEvent, getOpenTasksByConversation } from "@aula-agente/database";
import { TASK_TYPE_LABELS } from "@aula-agente/shared";
import type { Task, TaskType, TaskPriority, TaskAssigneeType } from "@aula-agente/shared";

interface Actor {
  type: "human" | "ai";
  id: string | null;
}

export async function completeTask(
  db: SupabaseClient,
  taskId: string,
  actor: Actor,
  note: string | null = null
): Promise<Task> {
  const task = await updateTask(db, taskId, { status: "completed", completed_at: new Date().toISOString() });
  await addTaskEvent(db, {
    task_id: taskId,
    organization_id: task.organization_id,
    event_type: "completed",
    note,
    created_by_type: actor.type,
    created_by_id: actor.id,
  });
  return task;
}

// Fires when a human sends the first manual message in a conversation
// (the takeover moment) — see messages/send.ts and webhooks/evolution.ts
// (fromMe branch, where actorId is null: no dashboard session to attribute
// it to). Best-effort: the caller swallows errors so a task lookup/write
// failure never blocks the message.
//
// A conversation can have more than one open task at a time (different
// task types created on different days) — the human taking over means
// they're now handling all of them, not just the most recently created
// one, so every open task gets completed.
export async function autoCompleteConversationTask(
  db: SupabaseClient,
  organizationId: string,
  conversationId: string,
  actorId: string | null
): Promise<Task[]> {
  const openTasks = await getOpenTasksByConversation(db, organizationId, conversationId);
  return Promise.all(
    openTasks.map((task) =>
      completeTask(
        db,
        task.id,
        { type: "human", id: actorId },
        "Concluída automaticamente — humano assumiu a conversa"
      )
    )
  );
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
