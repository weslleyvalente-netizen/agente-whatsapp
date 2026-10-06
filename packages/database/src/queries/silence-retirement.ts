import type {SupabaseClient} from "@supabase/supabase-js";
import type {SilenceRetirementInput,Task} from "@aula-agente/shared";
import {OPEN_TASK_STATUSES,addTaskEvent} from "./tasks.js";

export type SilenceRetirementCandidate = Omit<SilenceRetirementInput,"now"|"days"> & {rawTask: Task};

/** Open AI-created silence tasks plus the evidence needed to decide, all scoped to the organization. */
export async function getSilenceRetirementCandidates(db: SupabaseClient, organizationId: string, limit = 100): Promise<SilenceRetirementCandidate[]> {
 const {data: tasks, error} = await db.from("tasks").select("*").eq("organization_id", organizationId).eq("type", "customer_unresponsive").eq("created_by_type", "ai").in("status", OPEN_TASK_STATUSES).order("created_at").limit(limit);
 if (error) throw error;
 const out: SilenceRetirementCandidate[] = [];
 for (const task of (tasks ?? []) as Task[]) {
  if (!task.conversation_id) continue;
  const [others, lastContact, conversation, handoff, opportunities] = await Promise.all([
   db.from("tasks").select("id", {count: "exact", head: true}).eq("organization_id", organizationId).eq("contact_id", task.contact_id).in("status", OPEN_TASK_STATUSES).neq("id", task.id),
   db.from("messages").select("created_at").eq("organization_id", organizationId).eq("conversation_id", task.conversation_id).eq("role", "contact").order("created_at", {ascending: false}).limit(1).maybeSingle(),
   db.from("conversations").select("is_human_takeover").eq("organization_id", organizationId).eq("id", task.conversation_id).maybeSingle(),
   db.from("handoff_events").select("id").eq("organization_id", organizationId).eq("conversation_id", task.conversation_id).eq("trigger_type", "request_human").is("first_human_reply_at", null).limit(1),
   db.from("opportunities").select("stage,frozen_until,waiting_on,next_action_due_date").eq("organization_id", organizationId).eq("contact_id", task.contact_id).eq("status", "open"),
  ]);
  for (const r of [others, lastContact, conversation, handoff, opportunities]) if (r.error) throw r.error;
  const lastAt = lastContact.data?.created_at ?? null;
  let reached = false, human = false;
  if (lastAt) {
   const {data: after, error: afterError} = await db.from("messages").select("role").eq("organization_id", organizationId).eq("conversation_id", task.conversation_id).in("role", ["agent", "human_agent"]).gt("created_at", lastAt).limit(50);
   if (afterError) throw afterError;
   reached = (after ?? []).length > 0;
   human = (after ?? []).some(m => m.role === "human_agent");
  }
  out.push({rawTask: task, task, otherOpenTasks: others.count ?? 0, lastCustomerMessageAt: lastAt, reachedOutAfterCustomer: reached, humanTouchAfterCustomer: human, hasPendingHandoff: (handoff.data ?? []).length > 0, isHumanTakeover: conversation.data?.is_human_takeover === true, openOpportunities: (opportunities.data ?? []) as SilenceRetirementCandidate["openOpportunities"]});
 }
 return out;
}

/** No deletes: cancels with a recorded reason. The updated_at compare-and-set preserves a task a human touched meanwhile. */
export async function retireSilenceTask(db: SupabaseClient, organizationId: string, task: Task, reason: string): Promise<boolean> {
 const {data, error} = await db.from("tasks").update({status: "cancelled", consolidated_pendencies: []}).eq("organization_id", organizationId).eq("id", task.id).eq("updated_at", task.updated_at).in("status", OPEN_TASK_STATUSES).select("id").maybeSingle();
 if (error) throw error;
 if (!data) return false;
 await addTaskEvent(db, {task_id: task.id, organization_id: organizationId, event_type: "cancelled", note: JSON.stringify({source: "silence_auto_retire", reason}), created_by_type: "ai", created_by_id: null});
 return true;
}

/** Evidence for deciding whether a stale priced conversation is a real stalled negotiation. */
export async function getStalledNegotiationEvidence(db: SupabaseClient, organizationId: string, conversationId: string, contactId: string): Promise<import("@aula-agente/shared").StalledNegotiationEvidence> {
 const [customer, human, opportunities] = await Promise.all([
  db.from("messages").select("content").eq("organization_id", organizationId).eq("conversation_id", conversationId).eq("role", "contact").order("created_at", {ascending: false}).limit(50),
  db.from("messages").select("id", {count: "exact", head: true}).eq("organization_id", organizationId).eq("conversation_id", conversationId).eq("role", "human_agent"),
  db.from("opportunities").select("stage").eq("organization_id", organizationId).eq("contact_id", contactId).eq("status", "open"),
 ]);
 for (const r of [customer, human, opportunities]) if (r.error) throw r.error;
 return {customerMessages: (customer.data ?? []).map(m => m.content ?? ""), humanMessageCount: human.count ?? 0, openOpportunityStages: (opportunities.data ?? []).map(o => o.stage)};
}
