// UAZAPI da instância: conectar (cria a instância na UAZAPI, guarda o token cifrado, registra o webhook e devolve QR/código),
// consultar o estado e trocar o provedor ativo. Só gestor/admin (role diferente de "agent"). Nenhuma resposta devolve token.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAdminClient, getInstanceById, setInstanceProviderFields } from "@aula-agente/database";
import {
  decryptInstanceToken, encryptInstanceToken, resetWhatsAppTargetCache, uazapiConnect, uazapiCreateInstance, uazapiSetWebhook, uazapiStatus,
  UazapiHttpError,
} from "@aula-agente/agent-runtime";
import { authMiddleware } from "../../middleware/auth.js";

type Params = { Params: { instanceId: string } };
const WORKER_CACHE_SECONDS = 30;

async function loadManaged(request: FastifyRequest<Params>, reply: FastifyReply) {
  const instance = await getInstanceById(getAdminClient(), request.params.instanceId);
  const membership = request.user.memberships.find((m) => m.organization_id === instance.organization_id && m.role !== "agent");
  if (!membership) {
    await reply.status(403).send({ error: "Admin access required" });
    return null;
  }
  return instance;
}

function serverConfigured(): { webhookUrl: string } | null {
  const { UAZAPI_BASE_URL, UAZAPI_ADMIN_TOKEN, API_PUBLIC_URL, WEBHOOK_SECRET } = process.env;
  if (!UAZAPI_BASE_URL || !UAZAPI_ADMIN_TOKEN || !API_PUBLIC_URL || !WEBHOOK_SECRET) return null;
  return { webhookUrl: `${API_PUBLIC_URL.replace(/\/+$/, "")}/webhooks/uazapi?apikey=${encodeURIComponent(WEBHOOK_SECRET)}` };
}

export default async function instanceUazapiRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<Params & { Body: { phone?: unknown } }>("/instances/:instanceId/uazapi/connect", async (request, reply) => {
    const instance = await loadManaged(request, reply);
    if (!instance) return reply;
    const rawPhone = request.body?.phone;
    let phone: string | undefined;
    if (rawPhone !== undefined && rawPhone !== null && rawPhone !== "") {
      phone = String(rawPhone).replace(/\D/g, "");
      if (phone.length < 10 || phone.length > 15) return reply.status(400).send({ error: "Celular inválido: use DDI + DDD + número" });
    }
    const config = serverConfigured();
    if (!config) return reply.status(503).send({ error: "UAZAPI não configurada no servidor" });

    // Token guardado ilegível (UAZAPI_ADMIN_TOKEN trocado) ou recusado pela UAZAPI (instância apagada lá): cria a instância de novo.
    const createAndStore = async () => {
      const created = (await uazapiCreateInstance(instance.instance_name)).token;
      await setInstanceProviderFields(getAdminClient(), instance.id, { provider_token_encrypted: encryptInstanceToken(created) });
      request.log.info({ event: "uazapi_instance_created", instanceId: instance.id }, "UAZAPI instance created");
      return created;
    };
    let token: string | null = null;
    if (instance.provider_token_encrypted) {
      try { token = decryptInstanceToken(instance.provider_token_encrypted); } catch { token = null; }
    }
    let fresh = false;
    if (!token) { token = await createAndStore(); fresh = true; }
    try {
      await uazapiSetWebhook(token, config.webhookUrl);
    } catch (err) {
      if (fresh || !(err instanceof UazapiHttpError) || (err.status !== 401 && err.status !== 404)) throw err;
      token = await createAndStore();
      await uazapiSetWebhook(token, config.webhookUrl);
    }
    return uazapiConnect(token, phone);
  });

  app.get<Params>("/instances/:instanceId/uazapi/status", async (request, reply) => {
    const instance = await loadManaged(request, reply);
    if (!instance) return reply;
    const provider = instance.provider === "uazapi" ? "uazapi" : "evolution";
    if (!instance.provider_token_encrypted) return { provider, connected: false, status: "not_created", qrcode: null, paircode: null };
    try {
      const info = await uazapiStatus(decryptInstanceToken(instance.provider_token_encrypted));
      return { provider, connected: info.status === "connected", ...info };
    } catch (err) {
      // UAZAPI fora do ar ou token ilegível: a tela precisa continuar mostrando o provedor e a volta para a Evolution.
      request.log.warn({ event: "uazapi_status_unavailable", instanceId: instance.id, err: err instanceof Error ? err.name : "unknown" }, "UAZAPI status unavailable");
      return { provider, connected: false, status: "unavailable", qrcode: null, paircode: null };
    }
  });

  app.put<Params & { Body: { provider?: unknown } }>("/instances/:instanceId/provider", async (request, reply) => {
    const instance = await loadManaged(request, reply);
    if (!instance) return reply;
    const provider = request.body?.provider;
    if (provider !== "evolution" && provider !== "uazapi") return reply.status(400).send({ error: "provider deve ser evolution ou uazapi" });
    if (provider === "uazapi") {
      if (!instance.provider_token_encrypted) return reply.status(409).send({ error: "UAZAPI não está conectada" });
      const info = await uazapiStatus(decryptInstanceToken(instance.provider_token_encrypted));
      if (info.status !== "connected") return reply.status(409).send({ error: "UAZAPI não está conectada" });
    }
    await setInstanceProviderFields(getAdminClient(), instance.id, { provider });
    resetWhatsAppTargetCache();
    request.log.info({ event: "whatsapp_provider_switched", instanceId: instance.id, provider, userId: request.user.id }, "WhatsApp provider switched");
    return { ok: true, provider, effectiveWithinSeconds: WORKER_CACHE_SECONDS };
  });
}
