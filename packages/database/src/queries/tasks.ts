import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Task,
  TaskEvent,
  TaskEventType,
  TaskType,
  TaskPendency,
  TaskCreatedByType,
  TaskAssigneeType,
} from "@aula-agente/shared";
import {
  TASK_TYPE_LABELS,
  OPPORTUNITY_SIGNAL_TASK_TYPES,
  resolveTaskDedupAction,
  resolveOpportunityAutoLink,
  upsertPendency,
  removePendencyByType,
  pickPrimaryPendency,
  earliestDueDate,
  buildConsolidatedDescription,
} from "@aula-agente/shared";
import { getQualificationByConversationId } from "./conversation-qualification.js";
import { getOrganizationById } from "./organizations.js";
import { getOpenOpportunitiesByContact } from "./opportunities.js";

// Exported so callers that need to reason about "is this task still open"
// outside a query (e.g. apps/worker/src/workers/stale-conversation-followup.ts)
// can import the real list instead of keeping their own copy in sync by hand.
export const OPEN_TASK_STATUSES = ["pending", "in_progress", "rescheduled"];

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
    .is("opportunity_id", null)
    .in("status", OPEN_TASK_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Task | null;
}

export async function getOpenTaskByOpportunityAndType(
  client: SupabaseClient,
  organizationId: string,
  opportunityId: string,
  type: TaskType
) {
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("opportunity_id", opportunityId)
    .eq("type", type)
    .in("status", OPEN_TASK_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Task | null;
}

// Fase 2, item 2 (consolidation): looks up the open task for an opportunity
// ignoring type entirely — unlike getOpenTaskByOpportunityAndType, used only
// when task_consolidation_by_opportunity_enabled is on, so at most one open
// task exists per opportunity no matter what type each pendency started as.
export async function getOpenTaskByOpportunity(client: SupabaseClient, organizationId: string, opportunityId: string) {
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("opportunity_id", opportunityId)
    .in("status", OPEN_TASK_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Task | null;
}

// Every open task for a contact, any type/opportunity — used by
// findOpenTaskWithPendencyType (item 3) to search both a task's own `type`
// and its consolidated_pendencies for a match.
export async function getOpenTasksByContact(client: SupabaseClient, organizationId: string, contactId: string) {
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", OPEN_TASK_STATUSES)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as Task[];
}

// Fase 2, item 3: finds the open task carrying a pendency of this type for
// the contact — whether it's the task's own `type` (consolidation off, or
// this is the only pendency) or one entry among several in
// consolidated_pendencies (consolidation on). Returns null when none open.
export async function findOpenTaskWithPendencyType(
  client: SupabaseClient,
  organizationId: string,
  contactId: string,
  type: TaskType
): Promise<Task | null> {
  const openTasks = await getOpenTasksByContact(client, organizationId, contactId);
  return openTasks.find((t) => t.type === type || (t.consolidated_pendencies ?? []).some((p) => p.type === type)) ?? null;
}

// Fase 2, item 3: resolves ONE pendency (by type) on a task — if other
// pendencies remain in consolidated_pendencies, the task stays open with
// its principal fields recomputed from what's left; if this was the only
// one, the task is completed outright. Always logs an event either way, so
// "how many were auto-closed by this feature" stays queryable.
export async function resolveAwaitingCustomerPendency(
  client: SupabaseClient,
  organizationId: string,
  taskId: string,
  resolvedType: TaskType,
  note: string
): Promise<{ taskCompleted: boolean }> {
  const task = await getTaskById(client, taskId);
  const pendencies = task.consolidated_pendencies ?? [];
  const hasOthers = pendencies.filter((p) => p.type !== resolvedType).length > 0;

  if (hasOthers) {
    const remaining = removePendencyByType(pendencies, resolvedType);
    const primary = pickPrimaryPendency(remaining)!;
    await updateTask(client, taskId, {
      type: primary.type,
      title: TASK_TYPE_LABELS[primary.type],
      description: buildConsolidatedDescription(remaining),
      reason: primary.reason,
      priority: primary.priority,
      due_date: earliestDueDate(remaining)!,
      due_time: primary.due_time,
      consolidated_pendencies: remaining,
    });
    await addTaskEvent(client, {
      task_id: taskId,
      organization_id: organizationId,
      event_type: "consolidated_pendency_resolved",
      note,
      created_by_type: "ai",
      created_by_id: null,
    });
    return { taskCompleted: false };
  }

  await updateTask(client, taskId, {
    status: "completed",
    completed_at: new Date().toISOString(),
    consolidated_pendencies: [],
  });
  await addTaskEvent(client, {
    task_id: taskId,
    organization_id: organizationId,
    event_type: "completed",
    note,
    created_by_type: "ai",
    created_by_id: null,
  });
  return { taskCompleted: true };
}

// Fase 2, item 5(c): daily cap on new libera_cred_resumption tasks — counts
// task_events of a given type created since a cutoff, org-wide. No new
// table: reuses task_events the same way handoff_events.trigger_type is
// already used to measure Fase 1's rollout.
export async function countTaskEventsSince(
  client: SupabaseClient,
  organizationId: string,
  eventType: TaskEventType,
  sinceISO: string
): Promise<number> {
  const { count, error } = await client
    .from("task_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("event_type", eventType)
    .gte("created_at", sinceISO);
  if (error) throw error;
  return count ?? 0;
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

// A conversation can have several open tasks at once (e.g. a
// "financing_followup" and a "vehicle_followup" created on different days).
// Unlike getOpenTaskByConversation, this returns every one of them — used
// where "is there an open task" needs to become "every open task", such as
// auto-completing on human takeover.
export async function getOpenTasksByConversation(
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
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as Task[];
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
  opportunity_id?: string | null;
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

// Best-effort: a settings-fetch failure (or an environment where
// organizations isn't reachable, e.g. some unit tests) must never block
// task creation — it just means the Fase 2 flags below fall back to their
// safe default (off, today's behavior), exactly like the ai_summary
// snapshot lookup already does a few lines down.
async function getTaskConsolidationSettings(client: SupabaseClient, organizationId: string) {
  try {
    const org = await getOrganizationById(client, organizationId);
    return {
      autoLinkEnabled: org.settings?.task_auto_link_opportunity_enabled ?? false,
      consolidationEnabled: org.settings?.task_consolidation_by_opportunity_enabled ?? false,
    };
  } catch (err) {
    console.error("Failed to load organization settings for task consolidation, defaulting to off:", err);
    return { autoLinkEnabled: false, consolidationEnabled: false };
  }
}

function toPendency(input: CreateTaskWithDedupInput): TaskPendency {
  return {
    type: input.type,
    description: input.description,
    reason: input.reason,
    priority: input.priority,
    due_date: input.due_date,
    due_time: input.due_time ?? null,
    added_at: new Date().toISOString(),
    added_by_type: input.created_by_type,
    added_by_id: input.created_by_id,
  };
}

// Defensive seed for a task that predates this column (or was never touched
// by the consolidated path before) — turns its own current fields into the
// single pendency it implicitly represents, so merging never loses it.
function pendencyFromTask(task: Task): TaskPendency {
  return {
    type: task.type,
    description: task.description,
    reason: task.reason,
    priority: task.priority,
    due_date: task.due_date,
    due_time: task.due_time,
    added_at: task.created_at,
    added_by_type: task.created_by_type,
    added_by_id: task.created_by_id,
  };
}

export async function createTaskWithDedup(
  client: SupabaseClient,
  input: CreateTaskWithDedupInput
): Promise<{ task: Task; wasUpdated: boolean }> {
  const { autoLinkEnabled, consolidationEnabled } = await getTaskConsolidationSettings(
    client,
    input.organization_id
  );

  let opportunityId = input.opportunity_id ?? null;
  const wasAutoLinked = !opportunityId && autoLinkEnabled;
  if (wasAutoLinked) {
    const openOpportunities = await getOpenOpportunitiesByContact(client, input.organization_id, input.contact_id);
    opportunityId = resolveOpportunityAutoLink(openOpportunities.map((o) => o.id));
  }

  const consolidating = !!opportunityId && consolidationEnabled;

  const existing = opportunityId
    ? consolidating
      ? await getOpenTaskByOpportunity(client, input.organization_id, opportunityId)
      : await getOpenTaskByOpportunityAndType(client, input.organization_id, opportunityId, input.type)
    : await getOpenTaskByContactAndType(client, input.organization_id, input.contact_id, input.type);

  if (existing && consolidating) {
    const currentPendencies = existing.consolidated_pendencies?.length
      ? existing.consolidated_pendencies
      : [pendencyFromTask(existing)];
    const merged = upsertPendency(currentPendencies, toPendency(input));
    const primary = pickPrimaryPendency(merged)!;
    const primaryChanged = primary.type !== existing.type;

    const task = await updateTask(client, existing.id, {
      type: primary.type,
      title: TASK_TYPE_LABELS[primary.type],
      description: buildConsolidatedDescription(merged),
      reason: primary.reason,
      priority: primary.priority,
      due_date: earliestDueDate(merged)!,
      due_time: primary.due_time,
      consolidated_pendencies: merged,
    });
    await addTaskEvent(client, {
      task_id: task.id,
      organization_id: input.organization_id,
      event_type: "consolidated_pendency_added",
      note: primaryChanged
        ? `Nova pendência (${TASK_TYPE_LABELS[input.type]}) virou a principal — antes era ${TASK_TYPE_LABELS[existing.type]}.`
        : `Nova pendência (${TASK_TYPE_LABELS[input.type]}) agrupada nesta tarefa — principal continua ${TASK_TYPE_LABELS[primary.type]}.`,
      created_by_type: input.created_by_type,
      created_by_id: input.created_by_id,
    });
    return { task, wasUpdated: true };
  }

  const decision = resolveTaskDedupAction(existing, {
    due_date: input.due_date,
    description: input.description,
    reason: input.reason,
  });

  if (decision.action === "update") {
    const task = await updateTask(client, decision.taskId, {
      ...decision.changes,
      consolidated_pendencies: [toPendency(input)],
    });
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

  // One-time photograph of "what we knew when this task was made" — never
  // read back as a live value. The panel always reads the qualification's
  // own summary via conversation_id, not this snapshot.
  let qualification: Awaited<ReturnType<typeof getQualificationByConversationId>> = null;
  if (input.conversation_id) {
    try {
      qualification = await getQualificationByConversationId(client, input.conversation_id);
    } catch (err) {
      // The ai_summary snapshot is explicitly best-effort — a lookup failure
      // (e.g. this migration not applied yet in this environment) must never
      // block task creation itself.
      console.error("Failed to look up qualification for ai_summary snapshot:", err);
    }
  }

  const task = await createTask(client, {
    organization_id: input.organization_id,
    contact_id: input.contact_id,
    conversation_id: input.conversation_id,
    opportunity_id: opportunityId,
    assignee_type: assigneeType,
    assignee_id: assigneeId,
    type: input.type,
    title: TASK_TYPE_LABELS[input.type],
    description: input.description,
    ai_summary: qualification?.summary ?? null,
    reason: input.reason,
    priority: input.priority,
    status: "pending",
    due_date: input.due_date,
    due_time: input.due_time ?? null,
    created_by_type: input.created_by_type,
    created_by_id: input.created_by_id,
    consolidated_pendencies: [toPendency(input)],
  });

  await addTaskEvent(client, {
    task_id: task.id,
    organization_id: input.organization_id,
    event_type: "created",
    note: null,
    created_by_type: input.created_by_type,
    created_by_id: input.created_by_id,
  });

  if (wasAutoLinked && opportunityId) {
    await addTaskEvent(client, {
      task_id: task.id,
      organization_id: input.organization_id,
      event_type: "opportunity_auto_linked",
      note: "Vinculada automaticamente à única oportunidade aberta do contato.",
      created_by_type: "ai",
      created_by_id: null,
    });
  }

  return { task, wasUpdated: false };
}
