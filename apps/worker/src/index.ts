import "dotenv/config";
import { startProcessMessageWorker } from "./workers/process-message.js";
import { startSendMessageWorker } from "./workers/send-message";
import { startProcessDocumentWorker } from "./workers/process-document";
import { startTakeoverTimeoutWorker } from "./workers/takeover-timeout";

async function main() {
  console.log("Starting workers...");

  const workers = [
    startProcessMessageWorker(),
    startSendMessageWorker(),
    startProcessDocumentWorker(),
    startTakeoverTimeoutWorker(),
  ];

  console.log(`${workers.length} workers started successfully`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down workers...");
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
