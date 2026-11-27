// Webhook da UAZAPI. A UAZAPI não assina o webhook: a autenticação é (1) o segredo na URL (?apikey=WEBHOOK_SECRET, mesmo
// middleware da Evolution) e (2) o `token` da instância que vem no corpo, comparado em tempo constante com o guardado (cifrado).
// O evento é traduzido para o formato interno e repassado à rota da Evolution, que faz todo o processamento de sempre
// (ecos, @lid, anúncio, contato ignorado, guarda de mensagem atrasada, IA). O cabeçalho de repasse diz à rota que o evento veio da
// UAZAPI; a rota só aceita eventos do provedor ativo da instância.
import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { describeShape, translateUazapiEvent } from "@aula-agente/shared";
import { getAdminClient, getInstanceByInstanceName } from "@aula-agente/database";
import { decryptInstanceToken } from "@aula-agente/agent-runtime";
import { webhookVerifyMiddleware } from "../../middleware/webhook-verify.js";
import { REPLAY_TOKEN } from "../../lib/replay-token.js";
import { PROVIDER_RELAY_HEADER } from "./evolution.js";
import { recordWebhookEvent } from "../../services/webhook-pulse.js";

const digest = (v: string) => createHash("sha256").update(v).digest();

function sameToken(received: unknown, stored: string | null | undefined): boolean {
  if (typeof received !== "string" || !received || !stored) return false;
  let expected: string;
  try {
    expected = decryptInstanceToken(stored);
  } catch {
    return false;
  }
  return timingSafeEqual(digest(received), digest(expected));
}

export default async function uazapiWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/uazapi", {
    preHandler: [webhookVerifyMiddleware],
    handler: async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const instanceName = typeof body.instanceName === "string" ? body.instanceName : "";
      const instance = instanceName ? await getInstanceByInstanceName(getAdminClient(), instanceName) : null;
      if (!instance) {
        request.log.warn({ event: "uazapi_unknown_instance" }, "UAZAPI webhook for unknown instance");
        return reply.status(200).send({ ok: true, skipped: "unknown_instance" });
      }
      if (!sameToken(body.token, instance.provider_token_encrypted)) {
        request.log.warn({ event: "uazapi_bad_token", instance: instanceName }, "UAZAPI webhook with invalid instance token");
        return reply.status(401).send({ error: "Invalid instance token" });
      }
      // Pulso do webhook (monitor de saúde do provedor): qualquer evento autenticado prova que a entrega está viva.
      recordWebhookEvent(instance.id, body.EventType);

      const translation = translateUazapiEvent(body, instance.instance_id);
      if (body.EventType === "messages" || body.EventType === "messages_update") {
        const message = body.message as Record<string, unknown> | undefined;
        request.log.info({
          event: "uazapi_event_shape",
          eventType: body.EventType,
          messageType: typeof message?.messageType === "string" ? message.messageType : (typeof body.type === "string" ? body.type : null),
          kind: translation.kind,
          recognized: translation.kind === "message" ? translation.recognized : null,
          shape: describeShape(message ?? body.event),
        }, "UAZAPI event shape");
      }

      const relay = (payload: unknown) => app.inject({
        method: "POST",
        url: "/webhooks/evolution",
        headers: { apikey: process.env.WEBHOOK_SECRET ?? "", [PROVIDER_RELAY_HEADER]: REPLAY_TOKEN },
        payload: payload as Record<string, unknown>,
      });

      switch (translation.kind) {
        case "message": {
          const r = await relay(translation.payload);
          return reply.status(r.statusCode).header("content-type", "application/json").send(r.body);
        }
        case "status": {
          for (const event of translation.events) await relay(event);
          return reply.status(200).send({ ok: true, statuses: translation.events.length });
        }
        case "connection":
          request.log.info({ event: "uazapi_connection", instance: instanceName, status: translation.status }, "UAZAPI connection event");
          return reply.status(200).send({ ok: true, connection: translation.status });
        case "ignored":
          return reply.status(200).send({ ok: true, skipped: translation.reason });
      }
    },
  });
}
