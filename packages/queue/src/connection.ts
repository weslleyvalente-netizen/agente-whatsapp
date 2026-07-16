import { Redis as IORedis } from "ioredis";

let connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (connection) return connection;

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  return connection;
}
