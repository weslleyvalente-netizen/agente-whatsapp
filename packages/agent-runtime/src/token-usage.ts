export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface AiSdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

// generateText, generateObject and streamText all return this same usage
// shape — pulled out once so every call site (agent-runner, Trainer,
// image description, config-import suggestions) reads cache tokens the
// same way instead of re-deriving it.
export function extractTokenUsage(usage: AiSdkUsage | undefined): TokenUsage {
  return {
    inputTokens: usage?.inputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens || 0,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens || 0,
  };
}
