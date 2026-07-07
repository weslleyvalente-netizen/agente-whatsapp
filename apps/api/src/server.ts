import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";

const server = Fastify({ logger: true });

server.register(cors, { origin: true });

server.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

const start = async () => {
  const port = parseInt(process.env.API_PORT || "3001", 10);
  await server.listen({ port, host: "0.0.0.0" });
  server.log.info(`API server running on port ${port}`);
};

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
