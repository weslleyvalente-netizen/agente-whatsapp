import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deletePushSubscription, getAdminClient, isPushConfigured, sendPushToUser, upsertPushSubscription } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";

const subscribeBody = z.object({
  organizationId: z.string().uuid(),
  endpoint: z.string().url().startsWith("https://").max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
});
const unsubscribeBody = z.object({ endpoint: z.string().min(1).max(2048) });

export default async function pushRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // Sem chaves VAPID o recurso fica inerte: a chave vem nula e o app mostra "indisponível".
  app.get("/push/public-key", async () => ({ publicKey: isPushConfigured() ? process.env.VAPID_PUBLIC_KEY! : null }));

  app.post("/push/subscribe", async (request, reply) => {
    const parsed = subscribeBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues });
    const { organizationId, endpoint, keys } = parsed.data;
    if (!request.user.memberships.some((m: { organization_id: string }) => m.organization_id === organizationId)) return reply.status(403).send({ error: "Access denied" });
    try {
      const outcome = await upsertPushSubscription(getAdminClient(), {
        organizationId, userId: request.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      if (outcome === "conflict") return reply.status(409).send({ error: "Este aparelho já está vinculado a outro usuário. Desative as notificações nele e tente de novo." });
      return { ok: true };
    } catch (err) {
      request.log.error({ err }, "Failed to save push subscription");
      return reply.status(500).send({ error: "Erro ao ativar as notificações" });
    }
  });

  app.post("/push/unsubscribe", async (request, reply) => {
    const parsed = unsubscribeBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues });
    try {
      await deletePushSubscription(getAdminClient(), request.user.id, parsed.data.endpoint);
      return { ok: true };
    } catch (err) {
      request.log.error({ err }, "Failed to remove push subscription");
      return reply.status(500).send({ error: "Erro ao desativar as notificações" });
    }
  });

  app.post("/push/test", async (request, reply) => {
    if (!isPushConfigured()) return reply.status(503).send({ error: "Notificações não configuradas no servidor" });
    try {
      return await sendPushToUser(getAdminClient(), request.user.id, {
        title: "Moto e Trilha", body: "Notificações ativadas neste aparelho.", url: "/", tag: "push-test",
      });
    } catch (err) {
      request.log.error({ err }, "Failed to send test push");
      return reply.status(500).send({ error: "Erro ao enviar o teste" });
    }
  });
}
