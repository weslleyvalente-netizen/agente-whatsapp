import type { FastifyInstance } from "fastify";
import {
  getAdminClient,
  getConversationStatusesByOrganization,
  getMessagesForDashboard,
  getHumanTakeoverConversations,
  getRecentMessages,
} from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";

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

      const [conversations, windowMessages, takeoverConversations] = await Promise.all([
        getConversationStatusesByOrganization(db, organizationId),
        getMessagesForDashboard(db, organizationId, sinceISO),
        getHumanTakeoverConversations(db, organizationId),
      ]);

      const lastMessages = await Promise.all(
        takeoverConversations.map((c) => getRecentMessages(db, c.id, 1))
      );
      const lastMessageByConversationId: Record<string, LastMessageRow | undefined> = {};
      takeoverConversations.forEach((c, i) => {
        lastMessageByConversationId[c.id] = lastMessages[i][0];
      });

      return buildDashboardSummary(
        conversations,
        windowMessages,
        takeoverConversations,
        lastMessageByConversationId
      );
    }
  );
}
