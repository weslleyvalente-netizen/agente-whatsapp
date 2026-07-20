import type { FastifyInstance } from "fastify";
import { computeMessageCostUsd } from "@aula-agente/shared";
import type { MessageMetadata } from "@aula-agente/shared";
import { getAdminClient, getAgentMessagesForCost } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";

interface DailyCost {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

interface ModelCost {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  priced: boolean;
}

const DAYS_IN_WINDOW = 30;

function buildSummary(messages: Array<{ created_at: string; metadata: MessageMetadata | null }>) {
  const today = new Date().toISOString().slice(0, 10);
  const windowStart = new Date(Date.now() - DAYS_IN_WINDOW * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const dailyByDate = new Map<string, DailyCost>();
  const byModel = new Map<string, ModelCost>();

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let exactMessageCount = 0;
  let unpricedMessageCount = 0;
  let legacyMessageCount = 0;
  let todayCostUsd = 0;

  for (const message of messages) {
    const metadata = message.metadata;
    const model = metadata?.model || "unknown";
    const inputTokens = metadata?.input_tokens;
    const outputTokens = metadata?.output_tokens;

    if (inputTokens === undefined || outputTokens === undefined) {
      legacyMessageCount++;
      continue;
    }

    exactMessageCount++;
    const cost = computeMessageCostUsd(model, inputTokens, outputTokens);
    const date = message.created_at.slice(0, 10);

    const modelEntry = byModel.get(model) || {
      model,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      messageCount: 0,
      priced: cost !== null,
    };
    modelEntry.inputTokens += inputTokens;
    modelEntry.outputTokens += outputTokens;
    modelEntry.messageCount++;
    if (cost !== null) modelEntry.costUsd += cost;
    byModel.set(model, modelEntry);

    if (cost === null) {
      unpricedMessageCount++;
      continue;
    }

    totalCostUsd += cost;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    if (date === today) todayCostUsd += cost;

    if (date >= windowStart) {
      const dayEntry = dailyByDate.get(date) || {
        date,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        messageCount: 0,
      };
      dayEntry.costUsd += cost;
      dayEntry.inputTokens += inputTokens;
      dayEntry.outputTokens += outputTokens;
      dayEntry.messageCount++;
      dailyByDate.set(date, dayEntry);
    }
  }

  const last30dCostUsd = [...dailyByDate.values()].reduce((sum, day) => sum + day.costUsd, 0);

  return {
    totalCostUsd,
    todayCostUsd,
    last30dCostUsd,
    totalInputTokens,
    totalOutputTokens,
    exactMessageCount,
    unpricedMessageCount,
    legacyMessageCount,
    dailyCosts: [...dailyByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}

export default async function costRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/costs/summary",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const messages = await getAgentMessagesForCost(db, organizationId);
      return buildSummary(messages);
    }
  );
}
