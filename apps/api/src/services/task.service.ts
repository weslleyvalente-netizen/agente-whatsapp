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
// Taking over means the human is now the one handling these tasks — it
// does NOT mean they're resolved. A "Bom dia" doesn't close a pending
// simulation, a pending bank analysis, or an unanswered question. Every
// open task gets reassigned to the human and moved to in_progress (if
// still pending); completion stays an explicit action via the existing
// /tasks/:taskId/complete flow. A conversation can have more than one
// open task at a time (different task types created on different days) —
// each is reassigned independently, not merged into one action.
//
// actorId is null on the fromMe path (human replied from their own phone,
// no dashboard session). tasks.assignee has a DB check requiring
// assignee_id whenever assignee_type='human', so assignee fields are
// omitted entirely when actorId is null rather than sent as a doomed
// human/null pair.
export async function handleConversationTakeover(
  db: SupabaseClient,
  organizationId: string,
  conversationId: string,
  actorId: string | null
): Promise<Task[]> {
  const openTasks = await getOpenTasksByConversation(db, organizationId, conversationId);
  return Promise.all(
    openTasks.map(async (task) => {
      const updated = await updateTask(db, task.id, {
        ...(actorId ? { assignee_type: "human" as const, assignee_id: actorId } : {}),
        status: task.status === "pending" ? "in_progress" : task.status,
      });
      await addTaskEvent(db, {
        task_id: task.id,
        organization_id: task.organization_id,
        event_type: "assigned",
        note: "Humano assumiu a conversa — tarefa permanece aberta até conclusão explícita",
        created_by_type: "human",
        created_by_id: actorId,
      });
      return updated;
    })
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
  opportunity_id?: string | null;
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
