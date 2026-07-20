// USD price per 1M tokens. Only models offered in the agent model selector
// (see apps/web/src/components/agents/agent-form.tsx) are priced here.
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
};

export function getModelPricing(model: string) {
  return MODEL_PRICING[model] ?? null;
}

export function computeMessageCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
