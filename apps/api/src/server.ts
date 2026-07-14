import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import evolutionWebhookRoutes from "./routes/webhooks/evolution.js";
import messageSendRoutes from "./routes/messages/send.js";
import instanceRoutes from "./routes/instances/index.js";
import knowledgeDocumentRoutes from "./routes/knowledge/documents.js";
import knowledgeFaqRoutes from "./routes/knowledge/faqs.js";

const server = Fastify({ logger: true });

// Plugins
server.register(cors, { origin: true });

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
