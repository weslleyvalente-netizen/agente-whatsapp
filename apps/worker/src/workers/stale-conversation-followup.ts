import { Worker } from "bullmq";
import {
  QUEUE_NAMES,
  DEFAULT_FOLLOWUP_AUTOMATICO,
  DEFAULT_TASK_RULES,
  decideFollowupStage,
  toISODateInTimeZone,
} from "@aula-agente/shared";
import type { StaleConversationFollowupJobData } from "@aula-agente/queue";
import { getRedisConnection, getStaleConversationFollowupQueue, getSendMessageQueue } from "@aula-agente/queue";
import {
  getAdminClient,
  getAllOrganizations,
  getAgentsByOrganization,
  getStaleWaitingConversations,
  getConversationById,
  getRecentMessages,
  getLastContactMessage,
  getOpenTaskByConversation,
  getOpenTaskByContactAndType,
  getLatestTaskByConversationAndType,
  getTaskEvents,
  hasOpportunitySignalTask,
  createTaskWithDedup,
  updateTask,
  updateConversation,
  addTaskEvent,
  createMessage,
  OPEN_TASK_STATUSES,
} from "@aula-agente/database";
import { resolveApiKey, runAgent } from "@aula-agente/agent-runtime";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";
import { buildFollowupNudgeMessage } from "../lib/followup-nudge.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// The worker's original behavior (before followup_automatico existed): no
// AI messaging, just a customer_unresponsive task once the org's own
// stale_conversation_hours elapses. Runs for any agent that hasn't opted
// into the newer stage-based AI auto-followup below. Returns how many
// tasks it created, for the tick's summary log.
async function runBaselineTaskCheck(
  db: ReturnType<typeof getAdminClient>,
  org: { id: string; settings: unknown },
  agentId: string
): Promise<number> {
  const staleHours =
    (org.settings as { task_rules?: { stale_conversation_hours?: number } })?.task_rules
      ?.stale_conversation_hours ?? DEFAULT_TASK_RULES.stale_conversation_hours;
  const cutoffISO = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();

  const staleConversations = await getStaleWaitingConversations(db, org.id, agentId, cutoffISO);
  let created = 0;

  for (const conversation of staleConversations) {
    try {
      const openTask = await getOpenTaskByConversation(db, org.id, conversation.id);
      if (openTask) continue;

      // Don't re-fire for the same stretch of silence: only create another
      // customer_unresponsive task if the customer has spoken since the last one.
      const priorAutoTask = await getLatestTaskByConversationAndType(
        db,
        org.id,
        conversation.id,
        "customer_unresponsive"
      );
      if (priorAutoTask && conversation.last_message_at <= priorAutoTask.created_at) continue;

      const hasSignal = await hasOpportunitySignalTask(db, org.id, conversation.contact_id);
      if (!hasSignal) continue;

      // createTaskWithDedup keys off (contact_id, type), not conversation_id
      // — if this same contact has an older open customer_unresponsive task
      // tied to a DIFFERENT conversation, it would silently rewrite that
      // other task's description/reason to describe *this* conversation's
      // staleness instead. Skip rather than corrupt someone else's task.
      const contactOpenTask = await getOpenTaskByContactAndType(
        db,
        org.id,
        conversation.contact_id,
        "customer_unresponsive"
      );
      if (contactOpenTask && contactOpenTask.conversation_id !== conversation.id) continue;

      await createTaskWithDedup(db, {
        organization_id: org.id,
        contact_id: conversation.contact_id,
        conversation_id: conversation.id,
        type: "customer_unresponsive",
        description: `Cliente parou de responder há mais de ${staleHours}h, com sinal de oportunidade em aberto.`,
        reason: `Sem resposta há mais de ${staleHours}h`,
        priority: "high",
        due_date: toISODateInTimeZone(new Date()),
        created_by_type: "ai",
        created_by_id: null,
      });
      created++;
    } catch (err) {
      console.error(
        `Stale-conversation-followup: error in baseline task check for conversation ${conversation.id}:`,
        err
      );
    }
  }

  return created;
}

export function startStaleConversationFollowupWorker() {
  const worker = new Worker<StaleConversationFollowupJobData>(
    QUEUE_NAMES.STALE_CONVERSATION_FOLLOWUP,
    async () => {
      const db = getAdminClient();
      const organizations = await getAllOrganizations(db);
      let sent = 0;
      let created = 0;

      for (const org of organizations) {
        const agents = await getAgentsByOrganization(db, org.id);

        for (const agent of agents) {
          if (!agent.is_active) continue;

          const followupConfig = agent.tools_config.followup_automatico ?? DEFAULT_FOLLOWUP_AUTOMATICO;

          // AI auto-messaging is off for this agent (the default — every
          // existing org until it explicitly opts in). Fall back to this
          // worker's pre-followup-automático behavior: just alert staff with
          // a customer_unresponsive task once the conversation goes stale,
          // per the org's own stale_conversation_hours. Without this branch,
          // every org that never opted into AI auto-messaging would silently
          // stop getting these staff alerts entirely on deploy.
          if (!followupConfig.ativo) {
            created += await runBaselineTaskCheck(db, org, agent.id);
            continue;
          }

          const cutoffISO = new Date(
            Date.now() - followupConfig.primeiro_followup_horas * 60 * 60 * 1000
          ).toISOString();

          const staleConversations = await getStaleWaitingConversations(db, org.id, agent.id, cutoffISO);

          for (const conversation of staleConversations) {
            try {
              const hasSignal = await hasOpportunitySignalTask(db, org.id, conversation.contact_id);
              if (!hasSignal) continue;

              // Correction #1 (see plan's Global Constraints): only the real
              // last message tells us whether Helena is the one waiting.
              const lastMessages = await getRecentMessages(db, conversation.id, 1);
              const lastMessage = lastMessages[0];
              if (!lastMessage || lastMessage.role !== "agent") continue;

              // Correction #2: anchor the two windows to when the customer
              // actually went quiet, not to last_message_at (which Helena's
              // own follow-up sends would otherwise keep bumping forward).
              const lastContact = await getLastContactMessage(db, conversation.id);
              const anchorISO = lastContact?.created_at ?? conversation.created_at;
              const hoursSilent = (Date.now() - new Date(anchorISO).getTime()) / (1000 * 60 * 60);

              const existingTask = await getLatestTaskByConversationAndType(
                db,
                org.id,
                conversation.id,
                "customer_unresponsive"
              );
              const events = existingTask ? await getTaskEvents(db, existingTask.id) : [];
              const stage1AlreadySent = events.some(
                (e) => e.event_type === "auto_followup_stage_1" && e.created_at > anchorISO
              );
              const stage2AlreadySent = events.some(
                (e) => e.event_type === "auto_followup_stage_2" && e.created_at > anchorISO
              );

              const decision = decideFollowupStage({
                hoursSinceCustomerReply: hoursSilent,
                primeiroFollowupHoras: followupConfig.primeiro_followup_horas,
                segundoFollowupHoras: followupConfig.segundo_followup_horas,
                stage1AlreadySent,
                stage2AlreadySent,
              });

              if (decision === "none") continue;

              // Don't pile a followup message on top of an unrelated open task
              // that's already tracking next steps for this conversation — but
              // only before stage 1 has fired for THIS silence stretch (an old,
              // closed customer_unresponsive task from a previous stretch
              // shouldn't suppress this gate); stage 2 always continues the
              // one stage 1 created for this stretch.
              if (decision === "send_stage_1" && !stage1AlreadySent) {
                const otherOpenTask = await getOpenTaskByConversation(db, org.id, conversation.id);
                if (otherOpenTask) continue;
              }

              // If a human already closed out the customer_unresponsive task
              // (decided not to re-contact this customer), don't let the
              // automated stage 2 message fire once the second window elapses.
              if (
                decision === "send_stage_2" &&
                existingTask &&
                !OPEN_TASK_STATUSES.includes(existingTask.status)
              ) {
                continue;
              }

              const stage = decision === "send_stage_1" ? 1 : 2;

              const lockValue = await acquireConversationLock(conversation.id);
              if (!lockValue) continue; // being handled by process-message right now — try again next tick

              try {
                // Re-validate state that could have changed while we were
                // waiting (up to 10s) for the lock: process-message.ts may
                // have just handled a real customer reply, or a human may
                // have just taken over this conversation.
                const fullConversation = await getConversationById(db, conversation.id);
                if (fullConversation.is_human_takeover) continue;

                // "Desativar IA permanentemente" (wa_contacts.ai_disabled) is
                // meant to stop every automated message to this contact, not
                // just normal replies — process-message.ts and evolution.ts
                // already gate on it, this worker never did. Without this,
                // a contact staff explicitly disabled the AI for could still
                // get an automatic re-engagement nudge from it.
                if (fullConversation.wa_contacts?.ai_disabled) continue;

                const latestMessages = await getRecentMessages(db, conversation.id, 1);
                const latestMessage = latestMessages[0];
                if (!latestMessage || latestMessage.role !== "agent") continue;

                const phone = fullConversation.wa_contacts?.phone;
                if (!phone) {
                  console.warn(
                    `Stale-conversation-followup: skipping conversation ${conversation.id} — no phone on wa_contacts`
                  );
                  continue;
                }

                const apiKey = await resolveApiKey(org.id, agent.provider);
                const history = await getRecentMessages(db, conversation.id, 20);
                const nudge = buildFollowupNudgeMessage({
                  conversationId: conversation.id,
                  organizationId: org.id,
                  stage,
                  hoursSilent,
                });

                const result = await runAgent({
                  agent,
                  messages: history,
                  currentMessage: nudge,
                  apiKey,
                  organizationId: org.id,
                  conversationId: conversation.id,
                  instanceId: fullConversation.evolution_instance_id,
                  phone,
                  contactId: conversation.contact_id,
                  contactName: fullConversation.wa_contacts?.name ?? null,
                });

                if (result.text.trim()) {
                  const responseMessage = await createMessage(db, {
                    conversation_id: conversation.id,
                    organization_id: org.id,
                    evolution_message_id: null,
                    role: "agent",
                    content: result.text,
                    media_url: null,
                    media_type: null,
                    metadata: {
                      model: result.model,
                      input_tokens: result.inputTokens,
                      output_tokens: result.outputTokens,
                      cache_read_tokens: result.cacheReadTokens,
                      cache_write_tokens: result.cacheWriteTokens,
                      cache_status: result.cacheStatus,
                      latency_ms: result.latencyMs,
                      tool_calls: result.toolCalls,
                    },
                  });

                  await getSendMessageQueue().add("send-message", {
                    conversationId: conversation.id,
                    messageId: responseMessage.id,
                    instanceId: fullConversation.evolution_instance_id,
                    phone,
                    content: result.text,
                    organizationId: org.id,
                  });

                  // Every other send path in this codebase pairs createMessage
                  // with a last_message_at bump (process-message.ts,
                  // message.service.ts) — without it, this conversation never
                  // moves in any inbox view sorted by last_message_at and stays
                  // permanently inside getStaleWaitingConversations' cutoff
                  // filter, getting re-scanned every 15-minute tick forever.
                  await updateConversation(db, conversation.id, {
                    last_message_at: new Date().toISOString(),
                  });

                  sent++;
                }

                // createTaskWithDedup keys off (contact_id, type), not
                // conversation_id — if this same contact has an older open
                // customer_unresponsive task tied to a DIFFERENT conversation,
                // proceeding here would silently rewrite that other task's
                // description to describe *this* conversation instead. Skip
                // rather than corrupt someone else's task; the automated
                // message above was already sent (that decision is keyed by
                // conversation, correctly), only the task bookkeeping is
                // skipped.
                const contactOpenTask = await getOpenTaskByContactAndType(
                  db,
                  org.id,
                  conversation.contact_id,
                  "customer_unresponsive"
                );
                if (contactOpenTask && contactOpenTask.conversation_id !== conversation.id) {
                  continue;
                }

                const roundedHours = Math.round(hoursSilent);
                const { task } = await createTaskWithDedup(db, {
                  organization_id: org.id,
                  contact_id: conversation.contact_id,
                  conversation_id: conversation.id,
                  type: "customer_unresponsive",
                  description:
                    stage === 1
                      ? `Cliente parou de responder há mais de ${roundedHours}h — followup automático enviado.`
                      : `Cliente não respondeu nem à 2ª tentativa automática de followup, após mais de ${roundedHours}h de silêncio.`,
                  reason: `Sem resposta há mais de ${roundedHours}h`,
                  priority: stage === 1 ? "high" : "urgent",
                  due_date: toISODateInTimeZone(new Date()),
                  created_by_type: "ai",
                  created_by_id: null,
                });

                if (stage === 2) {
                  await updateTask(db, task.id, { priority: "urgent" });
                }

                await addTaskEvent(db, {
                  task_id: task.id,
                  organization_id: org.id,
                  event_type: stage === 1 ? "auto_followup_stage_1" : "auto_followup_stage_2",
                  note: result.text.trim()
                    ? `Followup automático (tentativa ${stage}) enviado ao cliente.`
                    : `Followup automático (tentativa ${stage}): a IA avaliou o contexto e decidiu não enviar mensagem.`,
                  created_by_type: "ai",
                  created_by_id: null,
                });
              } finally {
                await releaseConversationLock(conversation.id, lockValue);
              }
            } catch (err) {
              console.error(
                `Stale-conversation-followup: error processing conversation ${conversation.id}:`,
                err
              );
              continue;
            }
          }
        }
      }

      if (sent > 0) {
        console.log(`Sent ${sent} automatic followup message(s)`);
      }
      if (created > 0) {
        console.log(`Created ${created} customer_unresponsive task(s) (baseline, no auto-followup)`);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );

  const queue = getStaleConversationFollowupQueue();
  queue.upsertJobScheduler(
    "stale-conversation-followup-scheduler",
    { every: CHECK_INTERVAL_MS },
    { name: "check-stale-conversations" }
  );

  worker.on("failed", (job, err) => {
    console.error(`Stale-conversation-followup job ${job?.id} failed:`, err.message);
  });

  console.log("Stale-conversation-followup worker started (runs every 15 min)");
  return worker;
}
