// USD price per 1M tokens. Only models offered in the agent model selector
// (see apps/web/src/components/agents/agent-form.tsx) are priced here.
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
};

// Anthropic prices cached input tokens as a multiplier of the model's base
// input price, uniform across models. We only ever request the default
// (5-minute) cache TTL — see buildCacheableSystemMessages in
// packages/agent-runtime — so these are the 5m multipliers, not the
// pricier 1h ones.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function getModelPricing(model: string) {
  return MODEL_PRICING[model] ?? null;
}

export function computeMessageCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;

  // inputTokens is the call's TOTAL input (see LanguageModelUsage.inputTokens
  // in the `ai` package) — it already includes whatever was read from or
  // written to cache, so the non-cached remainder is what's left over.
  const noCacheTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);

  const cost =
    noCacheTokens * pricing.input +
    cacheWriteTokens * pricing.input * CACHE_WRITE_MULTIPLIER +
    cacheReadTokens * pricing.input * CACHE_READ_MULTIPLIER +
    outputTokens * pricing.output;

  return cost / 1_000_000;
}
