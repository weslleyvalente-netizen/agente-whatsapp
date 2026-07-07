import "dotenv/config";
import { getRedisConnection } from "@aula-agente/queue";

async function main() {
  const redis = getRedisConnection();

  redis.on("connect", () => {
    console.log("Worker connected to Redis");
  });

  redis.on("error", (err) => {
    console.error("Redis connection error:", err);
  });

  console.log("Worker started. Waiting for jobs...");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down worker...");
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
