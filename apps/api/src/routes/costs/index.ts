import type { FastifyInstance } from "fastify";
import { computeMessageCostUsd } from "@aula-agente/shared";
import type { MessageMetadata, AiUsageEvent } from "@aula-agente/shared";
import { getAdminClient, getAgentMessagesForCost, getAiUsageEventsForCost } from "@aula-agente/database";
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

interface SourceCost {
  source: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

// "conversation" (real customer messages, from `messages`) plus every
// AiUsageSource ("playground", "trainer", "image_description",
// "import_suggestion") — everything that costs money on the same Anthropic
// key, normalized to one shape so the aggregation loop below only has to
// run once.
interface CostItem {
  date: string;
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const DAYS_IN_WINDOW = 30;

function messagesToItems(messages: Array<{ created_at: string; metadata: MessageMetadata | null }>): {
  items: CostItem[];
  legacyMessageCount: number;
} {
  const items: CostItem[] = [];
  let legacyMessageCount = 0;

  for (const message of messages) {
    const metadata = message.metadata;
    const inputTokens = metadata?.input_tokens;
    const outputTokens = metadata?.output_tokens;

    // Undefined on messages sent before token metadata (or prompt caching)
    // shipped — these can't be priced at all, so they're counted separately
    // rather than silently treated as free.
    if (inputTokens === undefined || outputTokens === undefined) {
      legacyMessageCount++;
      continue;
    }

    items.push({
      date: message.created_at.slice(0, 10),
      source: "conversation",
      model: metadata?.model || "unknown",
      inputTokens,
      outputTokens,
      cacheReadTokens: metadata?.cache_read_tokens ?? 0,
      cacheWriteTokens: metadata?.cache_write_tokens ?? 0,
    });
  }

  return { items, legacyMessageCount };
}

function usageEventsToItems(
  events: Array<Pick<AiUsageEvent, "created_at" | "source" | "model" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens">>
): CostItem[] {
  return events.map((event) => ({
    date: event.created_at.slice(0, 10),
    source: event.source,
    model: event.model,
    inputTokens: event.input_tokens,
    outputTokens: event.output_tokens,
    cacheReadTokens: event.cache_read_tokens,
    cacheWriteTokens: event.cache_write_tokens,
  }));
}

export function buildSummary(
  messages: Array<{ created_at: string; metadata: MessageMetadata | null }>,
  usageEvents: Array<Pick<AiUsageEvent, "created_at" | "source" | "model" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens">>
) {
  const today = new Date().toISOString().slice(0, 10);
  const windowStart = new Date(Date.now() - DAYS_IN_WINDOW * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { items: messageItems, legacyMessageCount } = messagesToItems(messages);
  const items = [...messageItems, ...usageEventsToItems(usageEvents)];

  const dailyByDate = new Map<string, DailyCost>();
  const byModel = new Map<string, ModelCost>();
  const bySource = new Map<string, SourceCost>();

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let exactMessageCount = 0;
  let unpricedMessageCount = 0;
  let todayCostUsd = 0;

  for (const item of items) {
    exactMessageCount++;
    const cost = computeMessageCostUsd(item.model, item.inputTokens, item.outputTokens, item.cacheReadTokens, item.cacheWriteTokens);

    const modelEntry = byModel.get(item.model) || {
      model: item.model, costUsd: 0, inputTokens: 0, outputTokens: 0, messageCount: 0, priced: cost !== null,
    };
    modelEntry.inputTokens += item.inputTokens;
    modelEntry.outputTokens += item.outputTokens;
    modelEntry.messageCount++;
    if (cost !== null) modelEntry.costUsd += cost;
    byModel.set(item.model, modelEntry);

    const sourceEntry = bySource.get(item.source) || {
      source: item.source, costUsd: 0, inputTokens: 0, outputTokens: 0, messageCount: 0,
    };
    sourceEntry.inputTokens += item.inputTokens;
    sourceEntry.outputTokens += item.outputTokens;
    sourceEntry.messageCount++;
    if (cost !== null) sourceEntry.costUsd += cost;
    bySource.set(item.source, sourceEntry);

    if (cost === null) {
      unpricedMessageCount++;
      continue;
    }

    totalCostUsd += cost;
    totalInputTokens += item.inputTokens;
    totalOutputTokens += item.outputTokens;
    if (item.date === today) todayCostUsd += cost;

    if (item.date >= windowStart) {
      const dayEntry = dailyByDate.get(item.date) || {
        date: item.date, costUsd: 0, inputTokens: 0, outputTokens: 0, messageCount: 0,
      };
      dayEntry.costUsd += cost;
      dayEntry.inputTokens += item.inputTokens;
      dayEntry.outputTokens += item.outputTokens;
      dayEntry.messageCount++;
      dailyByDate.set(item.date, dayEntry);
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
    bySource: [...bySource.values()].sort((a, b) => b.costUsd - a.costUsd),
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
      const [messages, usageEvents] = await Promise.all([
        getAgentMessagesForCost(db, organizationId),
        getAiUsageEventsForCost(db, organizationId),
      ]);
      return buildSummary(messages, usageEvents);
    }
  );
}
