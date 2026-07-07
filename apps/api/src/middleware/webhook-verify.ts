import type { FastifyRequest, FastifyReply } from "fastify";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

export async function webhookVerifyMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // If no secret configured, skip verification (dev mode)
  if (!WEBHOOK_SECRET) {
    request.log.warn("WEBHOOK_SECRET not set — skipping webhook verification");
    return;
  }

  const apiKey = request.headers["apikey"] as string
    || request.headers["x-api-key"] as string;

  if (!apiKey || apiKey !== WEBHOOK_SECRET) {
    return reply.status(401).send({ error: "Invalid webhook secret" });
  }
}
