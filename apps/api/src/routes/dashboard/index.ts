import type { FastifyInstance } from "fastify";
import {
  getAdminClient,
  getConversationStatusesByOrganization,
  getMessagesForDashboard,
  getHumanTakeoverConversations,
  getRecentMessages,
  getPendingHandoffs,
  getOrganizationById,
  getOpenTasksWithScoreInputs,
  getFollowupMetrics,
  type OpenTaskWithScoreInputs,
} from "@aula-agente/database";
import {
  DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES,
  DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS,
  FUNNEL_STAGES,
  computeTaskPriorityScore,
  resolveTaskBucket, getOperationalTaskDueDate,
  toISODateInTimeZone,
  type Operation,
  type WaitingOn,
  type QualificationUrgency,
  type TaskPriorityScoreWeights,
} from "@aula-agente/shared";
import { authMiddleware } from "../../middleware/auth.js";

const TODAY_LIST_LIMIT = 10;

const WINDOW_DAYS = 7;
const MAX_URGENT = 20;

interface DashboardConversationRow {
  status: string;
}

interface DashboardMessageRow {
  conversation_id: string;
  role: string;
  created_at: string;
}

interface TakeoverConversationRow {
  id: string;
  human_takeover_at: string | null;
  wa_contacts: { name: string | null; phone: string } | null;
}

interface LastMessageRow {
  role: string;
  content: string;
  created_at: string;
}

export function buildDashboardSummary(
  conversations: DashboardConversationRow[],
  windowMessages: DashboardMessageRow[],
  takeoverConversations: TakeoverConversationRow[],
  lastMessageByConversationId: Record<string, LastMessageRow | undefined>
) {
  const inProgress = conversations.filter((c) => c.status === "open" || c.status === "waiting").length;

  const conversationsLast7d = new Set(windowMessages.map((m) => m.conversation_id)).size;

  const messagesByConversation = new Map<string, DashboardMessageRow[]>();
  for (const msg of windowMessages) {
    const list = messagesByConversation.get(msg.conversation_id) || [];
    list.push(msg);
    messagesByConversation.set(msg.conversation_id, list);
  }

  const responseDeltasMs: number[] = [];
  for (const msgs of messagesByConversation.values()) {
    let pendingContactAt: number | null = null;
    for (const msg of msgs) {
      if (msg.role === "contact") {
        if (pendingContactAt === null) {
          pendingContactAt = new Date(msg.created_at).getTime();
        }
      } else if (msg.role === "agent" && pendingContactAt !== null) {
        responseDeltasMs.push(new Date(msg.created_at).getTime() - pendingContactAt);
        pendingContactAt = null;
      } else if (msg.role === "human_agent" && pendingContactAt !== null) {
        pendingContactAt = null;
      }
    }
  }
  const avgResponseSeconds =
    responseDeltasMs.length > 0
      ? responseDeltasMs.reduce((sum, ms) => sum + ms, 0) / responseDeltasMs.length / 1000
      : null;

  const needsAttentionConversations = takeoverConversations.filter(
    (c) => lastMessageByConversationId[c.id]?.role === "contact"
  );

  const urgentConversations = needsAttentionConversations.slice(0, MAX_URGENT).map((c) => {
    const lastMessage = lastMessageByConversationId[c.id]!;
    return {
      conversationId: c.id,
      contactName: c.wa_contacts?.name ?? null,
      contactPhone: c.wa_contacts?.phone ?? "",
      lastMessagePreview: lastMessage.content,
      lastMessageAt: lastMessage.created_at,
    };
  });

  return {
    conversationsLast7d,
    inProgress,
    avgResponseSeconds,
    needsAttention: needsAttentionConversations.length,
    urgentConversations,
  };
}

interface PendingHandoffRow {
  id: string;
  conversation_id: string;
  handed_at: string;
  motivo: string | null;
  resumo: string | null;
  urgencia: string | null;
  conversations: { wa_contacts: { name: string | null; phone: string } | null } | null;
}

// Feeds the painel "Handoffs aguardando" card (Fase 1, itens 3-4): every
// open requestHuman handoff, with how long it's been waiting. `unanswered`
// crossing true is the "alerta de handoff sem resposta" — computed live,
// same as every other dashboard metric here, not a separately stored alert.
export function buildPendingHandoffs(rows: PendingHandoffRow[], nowMs: number, alertThresholdMinutes: number) {
  return rows
    .map((row) => {
      const waitMinutes = Math.round((nowMs - new Date(row.handed_at).getTime()) / 60_000);
      return {
        conversationId: row.conversation_id,
        contactName: row.conversations?.wa_contacts?.name ?? null,
        contactPhone: row.conversations?.wa_contacts?.phone ?? "",
        motivo: row.motivo,
        resumo: row.resumo,
        urgencia: row.urgencia,
        handedAt: row.handed_at,
        waitMinutes,
        unanswered: waitMinutes >= alertThresholdMinutes,
      };
    })
    .sort((a, b) => b.waitMinutes - a.waitMinutes);
}

export interface ScoredTodayTask {
  taskId: string;
  type: string;
  title: string;
  description: string;
  reason: string | null;
  priority: string;
  dueDate: string;
  contactName: string | null;
  contactPhone: string;
  conversationId: string | null;
  opportunityId: string | null;
  score: number;
}

// Fase 2, item 4: the "Hoje" view's top-10, built from raw open-task rows
// (getOpenTasksWithScoreInputs) plus the same unanswered-handoff set the
// "Handoffs aguardando" card already computes (buildPendingHandoffs) — no
// duplicated handoff logic. Pure and unit-tested on its own; the route
// handler below only wires DB calls to it.
export function buildTodayPriorityList(
  rows: OpenTaskWithScoreInputs[],
  unansweredHandoffConversationIds: Set<string>,
  todayISODate: string,
  weights: TaskPriorityScoreWeights,
  limit: number
): ScoredTodayTask[] {
  const scored = rows.filter(row=>!(row.task.opportunity_frozen_until && row.task.opportunity_frozen_until>todayISODate) && (!row.opportunity?.frozen_until || row.opportunity.frozen_until<=todayISODate)).map((row) => {
    const bucket = resolveTaskBucket(row.task, todayISODate);
    const dueDateBucket = bucket === "done" ? "upcoming" : bucket;

    const opp = row.opportunity;
    const opportunityValue = opp ? opp.credit_amount ?? opp.sale_amount ?? opp.bid_amount : null;

    let stagePosition: number | null = null;
    let stageCount: number | null = null;
    if (opp) {
      const stages = FUNNEL_STAGES[opp.operation as Operation] as readonly string[] | undefined;
      const idx = stages?.indexOf(opp.stage) ?? -1;
      if (stages && idx >= 0) {
        stagePosition = idx;
        stageCount = stages.length;
      }
    }

    const anchor = opp ? opp.last_progress_at ?? opp.last_interaction_at ?? opp.created_at : null;
    const daysStalled = anchor ? (Date.now() - new Date(anchor).getTime()) / (24 * 60 * 60 * 1000) : null;

    const score = computeTaskPriorityScore(
      {
        priority: row.task.priority,
        dueDateBucket,
        opportunityValue,
        stagePosition,
        stageCount,
        daysStalled,
        waitingOn: (opp?.waiting_on as WaitingOn | null) ?? null,
        waitingOnUntil: opp?.waiting_on_until ?? null,
        qualificationUrgency: row.qualificationUrgency as QualificationUrgency | null,
        hasUnansweredHandoff: row.task.conversation_id
          ? unansweredHandoffConversationIds.has(row.task.conversation_id)
          : false,
        todayISODate,
      },
      weights
    );

    const item: ScoredTodayTask = {
      taskId: row.task.id,
      type: row.task.type,
      title: row.task.title,
      description: row.task.description,
      reason: row.task.reason,
      priority: row.task.priority,
      dueDate: getOperationalTaskDueDate(row.task),
      contactName: row.contactName,
      contactPhone: row.contactPhone,
      conversationId: row.task.conversation_id,
      opportunityId: row.task.opportunity_id,
      score,
    };
    return item;
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export default async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/dashboard/summary",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const sinceISO = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

      const [conversations, windowMessages, takeoverConversations, org] = await Promise.all([
        getConversationStatusesByOrganization(db, organizationId),
        getMessagesForDashboard(db, organizationId, sinceISO),
        getHumanTakeoverConversations(db, organizationId),
        getOrganizationById(db, organizationId),
      ]);

      // Separate from the Promise.all above: a missing handoff_events table
      // (migration not deployed yet) must not take down the rest of the
      // dashboard summary — it degrades to an empty "Handoffs aguardando".
      let pendingHandoffRows: Awaited<ReturnType<typeof getPendingHandoffs>> = [];
      try {
        pendingHandoffRows = await getPendingHandoffs(db, organizationId);
      } catch (err) {
        request.log.error({ err, organizationId }, "Failed to load pending handoffs");
      }

      const lastMessages = await Promise.all(
        takeoverConversations.map((c) => getRecentMessages(db, c.id, 1))
      );
      const lastMessageByConversationId: Record<string, LastMessageRow | undefined> = {};
      takeoverConversations.forEach((c, i) => {
        lastMessageByConversationId[c.id] = lastMessages[i][0];
      });

      const alertThresholdMinutes =
        org.settings.handoff_unanswered_alert_minutes ?? DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES;

      return {
        ...buildDashboardSummary(conversations, windowMessages, takeoverConversations, lastMessageByConversationId),
        pendingHandoffs: buildPendingHandoffs(
          pendingHandoffRows as PendingHandoffRow[],
          Date.now(),
          alertThresholdMinutes
        ),
      };
    }
  );

  // Fase 2, item 4: top-10 open tasks/opportunities by priority score, with
  // direct actions in the panel (abrir conversa / concluir / adiar — reuses
  // the existing /inbox link and /tasks/:id/complete|reschedule endpoints,
  // no new write endpoint needed here). Read-only, no flag — see D6 in
  // docs/plano-fase2-triagem-tarefas.md.
  app.get<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/dashboard/today",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const [rows, org] = await Promise.all([
        getOpenTasksWithScoreInputs(db, organizationId),
        getOrganizationById(db, organizationId),
      ]);

      let pendingHandoffRows: Awaited<ReturnType<typeof getPendingHandoffs>> = [];
      try {
        pendingHandoffRows = await getPendingHandoffs(db, organizationId);
      } catch (err) {
        request.log.error({ err, organizationId }, "Failed to load pending handoffs for today view");
      }
      const alertThresholdMinutes =
        org.settings.handoff_unanswered_alert_minutes ?? DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES;
      const handoffs = buildPendingHandoffs(pendingHandoffRows as PendingHandoffRow[], Date.now(), alertThresholdMinutes);
      const unansweredHandoffConversationIds = new Set(
        handoffs.filter((h) => h.unanswered).map((h) => h.conversationId)
      );

      const weights: TaskPriorityScoreWeights = org.settings.task_priority_score_weights
        ? { ...DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS, ...org.settings.task_priority_score_weights }
        : DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS;

      const todayISODate = toISODateInTimeZone(new Date());
      const items = buildTodayPriorityList(rows, unansweredHandoffConversationIds, todayISODate, weights, TODAY_LIST_LIMIT);

      return { items };
    }
  );

  // D7: aggregate-only metrics (total/original/edited) for the follow-up
  // direto da tarefa feature — no dedicated report UI yet, see
  // docs/plano-followup-tarefa.md. Response-rate breakdown is deferred to a
  // future Fase de Medição.
  app.get<{ Params: { organizationId: string }; Querystring: { days?: string } }>(
    "/organizations/:organizationId/followups/metrics",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const days = Number(request.query.days) > 0 ? Number(request.query.days) : 30;
      const sinceISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const db = getAdminClient();
      const metrics = await getFollowupMetrics(db, organizationId, sinceISO);
      return metrics;
    }
  );
}
