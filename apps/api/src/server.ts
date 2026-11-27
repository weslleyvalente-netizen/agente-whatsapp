import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { invalidateSalesWorkspaceCacheOnWrite } from "./services/sales-workspace.service.js";
import evolutionWebhookRoutes from "./routes/webhooks/evolution.js";
import wixLeadWebhookRoutes from "./routes/webhooks/wix-lead.js";
import uazapiWebhookRoutes from "./routes/webhooks/uazapi.js";
import { requestLogSerializer } from "./lib/log-serializers.js";
import messageSendRoutes from "./routes/messages/send.js";
import messageSendAudioRoutes from "./routes/messages/send-audio.js";
import messageSendAttachmentRoutes from "./routes/messages/send-attachment.js";
import messageAudioUrlRoutes from "./routes/messages/audio-url.js";
import messageMediaUrlRoutes from "./routes/messages/media-url.js";
import profilePictureUrlsRoutes from "./routes/contacts/profile-picture-urls.js";
import adTouchesRoutes from "./routes/contacts/ad-touches.js";
import instanceRoutes from "./routes/instances/index.js";
import instanceUazapiRoutes from "./routes/instances/uazapi.js";
import knowledgeDocumentRoutes from "./routes/knowledge/documents.js";
import knowledgeFaqRoutes from "./routes/knowledge/faqs.js";
import costRoutes from "./routes/costs/index.js";
import dashboardRoutes from "./routes/dashboard/index.js";
import taskRoutes from "./routes/tasks/index.js";
import agentConfigRoutes from "./routes/agent-config/index.js";
import agentImageRoutes from "./routes/agent-config/images.js";
import conversationRoutes from "./routes/conversations/index.js";
import invitationRoutes from "./routes/invitations/index.js";
import opportunityRoutes from "./routes/opportunities/index.js";
import messageSuggestionRoutes from "./routes/opportunities/message-suggestion.js";
import callLogRoutes from "./routes/call-logs/index.js";
import leadDistributionRoutes from "./routes/lead-distribution/index.js";
import pushRoutes from "./routes/push/index.js";
import recoverMessagesRoutes from "./routes/admin/recover-messages.js";
import healthRoutes from "./routes/health/index.js";
import { startHealthMonitor } from "./services/health-monitor.js";
import { startAutoRecover } from "./services/auto-recover.js";
import { startEvolutionMonitor } from "./services/evolution-monitor.js";
import { getSilentMonitorStatus, startSilentConnectionAlert } from "./services/silent-connection-alert.js";
import { getProviderMonitorStatus, startProviderHealthMonitor } from "./services/provider-health-monitor.js";

import financingRoutes from './routes/financing/index.js';
import manualFinancingRoutes from './routes/manual-financing/index.js';

const server = Fastify({ logger: { serializers: { req: requestLogSerializer } } });

if (!process.env.WEBHOOK_SECRET) {
  server.log.warn("WEBHOOK_SECRET is not set: webhook verification is off and message recovery keeps no original timestamps");
}

// Plugins
// `methods` must be explicit: @fastify/cors' default preflight response only
// allows GET,HEAD,POST, silently blocking every PATCH (and PUT/DELETE) route
// in the browser with a generic "Failed to fetch" — no server-side log entry
// at all, since the browser never sends the real request once the preflight
// response omits the method. Discovered live while testing the agent-config
// PATCH route; affects every existing PATCH route in this file (e.g.
// `PATCH /tasks/:taskId`), not something introduced by any one feature.
// onSend (antes de a resposta chegar ao cliente) fecha a janela de corrida com o refetch da tela.
server.addHook("onSend", async (request, reply, payload) => { invalidateSalesWorkspaceCacheOnWrite(request, reply.statusCode); return payload; });
server.register(cors, { origin: true, methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"] });

// Health check
server.get("/health", async () => {
  // monitors: só estados em memória (sem dados de cliente); permite conferir, sem acesso ao painel, que o monitor "conexão muda" está no ar e ciclando.
  return { status: "ok", timestamp: new Date().toISOString(), monitors: { silentConnection: getSilentMonitorStatus(), providerHealth: getProviderMonitorStatus() } };
});

// Routes
server.register(financingRoutes);
server.register(manualFinancingRoutes);
server.register(evolutionWebhookRoutes);
server.register(uazapiWebhookRoutes);
server.register(wixLeadWebhookRoutes);
server.register(messageSendRoutes);
server.register(messageSendAudioRoutes);
server.register(messageSendAttachmentRoutes);
server.register(messageAudioUrlRoutes);
server.register(messageMediaUrlRoutes);
server.register(profilePictureUrlsRoutes);
server.register(adTouchesRoutes);
server.register(instanceRoutes);
server.register(instanceUazapiRoutes);
server.register(knowledgeDocumentRoutes);
server.register(knowledgeFaqRoutes);
server.register(costRoutes);
server.register(dashboardRoutes);
server.register(taskRoutes);
server.register(agentConfigRoutes);
server.register(agentImageRoutes);
server.register(conversationRoutes);
server.register(opportunityRoutes);
server.register(messageSuggestionRoutes);
server.register(callLogRoutes);
server.register(invitationRoutes);
server.register(leadDistributionRoutes);
server.register(pushRoutes);
server.register(recoverMessagesRoutes);
server.register(healthRoutes);

// Start
const start = async () => {
  const port = parseInt(process.env.API_PORT || "3001", 10);
  await server.listen({ port, host: "0.0.0.0" });
  server.log.info(`API server running on port ${port}`);
  // Alerta de silêncio: setInterval no próprio processo da API, sem fila (independe do Redis).
  startHealthMonitor(server.log);
  // Rede de segurança contra o WhatsApp "conectado mas surdo": reenvia o que a Evolution guardou e o CRM não recebeu (chave desligada por padrão).
  startAutoRecover(server, server.log);
  // Registro periódico do estado da conexão do Evolution (chave settings.evolution_monitor_enabled, desligada por padrão).
  startEvolutionMonitor(server.log);
  startSilentConnectionAlert(server.log); // desligado por padrão (settings.silent_connection_alert_mode: off | shadow | on); em off não toca a tabela de alertas
  startProviderHealthMonitor(server.log); // desligado por padrão (settings.provider_health_monitor_mode: off | shadow | on); em off não consulta a UAZAPI
};

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
