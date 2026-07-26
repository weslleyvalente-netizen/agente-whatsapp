import { getAdminClient } from "@aula-agente/database";
import type { LLMProvider } from "@aula-agente/shared";

// Cache for resolved keys (TTL: 5 minutes)
const keyCache = new Map<string, { key: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const ENV_FALLBACKS: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_AI_API_KEY",
};

export async function resolveApiKey(
  organizationId: string,
  provider: LLMProvider
): Promise<string> {
  const cacheKey = `${organizationId}:${provider}`;

  // Check cache
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  // Try organization secrets
  const db = getAdminClient();
  const { data, error } = await db
    .from("organization_secrets")
    .select("encrypted_key")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();

  if (!error && data?.encrypted_key) {
    keyCache.set(cacheKey, {
      key: data.encrypted_key,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return data.encrypted_key;
  }

  // Fallback to global env var
  const envKey = process.env[ENV_FALLBACKS[provider]];
  if (!envKey) {
    throw new Error(
      `No API key found for provider "${provider}" in organization "${organizationId}" or environment`
    );
  }

  return envKey;
}
