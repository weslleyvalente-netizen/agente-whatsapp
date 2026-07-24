import { getRedisConnection } from "@aula-agente/queue";

const LOCK_PREFIX = "lock:conversation:";
const LOCK_TTL_MS = 120_000; // 120 seconds max lock — audio transcription (Evolution fetch + Whisper, each individually timeout-bounded at 20s/30s) plus agent processing can legitimately take longer than the original 60s budget for a near-the-cap voice note.
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 20; // 10 seconds max wait

export async function acquireConversationLock(conversationId: string): Promise<string | null> {
  const redis = getRedisConnection();
  const lockKey = `${LOCK_PREFIX}${conversationId}`;
  const lockValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let i = 0; i < MAX_RETRIES; i++) {
    const result = await redis.set(lockKey, lockValue, "PX", LOCK_TTL_MS, "NX");
    if (result === "OK") {
      return lockValue;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  return null; // Failed to acquire lock
}

export async function releaseConversationLock(conversationId: string, lockValue: string) {
  const redis = getRedisConnection();
  const lockKey = `${LOCK_PREFIX}${conversationId}`;

  // Only release if we still hold the lock (Lua script for atomicity)
  const luaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  await redis.call("EVAL", luaScript, "1", lockKey, lockValue);
}
