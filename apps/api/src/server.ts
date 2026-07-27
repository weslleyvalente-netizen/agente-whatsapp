import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import evolutionWebhookRoutes from "./routes/webhooks/evolution.js";
import messageSendRoutes from "./routes/messages/send.js";
import instanceRoutes from "./routes/instances/index.js";
import knowledgeDocumentRoutes from "./routes/knowledge/documents.js";
import knowledgeFaqRoutes from "./routes/knowledge/faqs.js";
import costRoutes from "./routes/costs/index.js";
import dashboardRoutes from "./routes/dashboard/index.js";
import taskRoutes from "./routes/tasks/index.js";
import agentConfigRoutes from "./routes/agent-config/index.js";

const server = Fastify({ logger: true });

// Plugins
// `methods` must be explicit: @fastify/cors' default preflight response only
// allows GET,HEAD,POST, silently blocking every PATCH (and PUT/DELETE) route
// in the browser with a generic "Failed to fetch" — no server-side log entry
// at all, since the browser never sends the real request once the preflight
// response omits the method. Discovered live while testing the agent-config
// PATCH route; affects every existing PATCH route in this file (e.g.
// `PATCH /tasks/:taskId`), not something introduced by any one feature.
server.register(cors, { origin: true, methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"] });

// Health check
server.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

// Routes
server.register(evolutionWebhookRoutes);
server.register(messageSendRoutes);
server.register(instanceRoutes);
server.register(knowledgeDocumentRoutes);
server.register(knowledgeFaqRoutes);
server.register(costRoutes);
server.register(dashboardRoutes);
server.register(taskRoutes);
server.register(agentConfigRoutes);

// Start
const start = async () => {
  const port = parseInt(process.env.API_PORT || "3001", 10);
  await server.listen({ port, host: "0.0.0.0" });
  server.log.info(`API server running on port ${port}`);
};

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
