import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({ getInstanceByInstanceId: vi.fn(), applyMessageDeliveryStatus: vi.fn(), saveMessage: vi.fn() }));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  getInstanceByInstanceId: m.getInstanceByInstanceId,
  applyMessageDeliveryStatus: m.applyMessageDeliveryStatus,
  getOrganizationById: async () => ({ settings: {} }),
}));
vi.mock("../../services/message.service.js", () => ({ saveMessage: m.saveMessage }));
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: vi.fn() }));
vi.mock("../../services/evolution.service.js", () => ({ findMessagesByRemoteJid: vi.fn() }));
vi.mock("../../lib/queue.js", () => ({}));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: async () => undefined }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: async () => undefined }));

async function post(p: unknown) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: p as any }); await app.close(); return r;
}
const update = (data: Record<string, unknown>) => ({ event: "messages.update", instance: "inst", data });

beforeEach(() => {
  vi.clearAllMocks();
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1" });
  m.applyMessageDeliveryStatus.mockResolvedValue(undefined);
});

describe("webhook: status de entrega/leitura", () => {
  it("READ grava leitura na organização da instância e não cria mensagem", async () => {
    const r = await post(update({ keyId: "WA1", status: "READ", fromMe: true }));
    expect(r.statusCode).toBe(200);
    expect(m.applyMessageDeliveryStatus).toHaveBeenCalledWith({}, { organizationId: "org-1", evolutionMessageId: "WA1", status: "read" });
    expect(m.saveMessage).not.toHaveBeenCalled();
  });
  it("DELIVERY_ACK grava entrega", async () => {
    await post(update({ keyId: "WA1", status: "DELIVERY_ACK" }));
    expect(m.applyMessageDeliveryStatus).toHaveBeenCalledWith({}, expect.objectContaining({ status: "delivered" }));
  });
  it("SERVER_ACK e formato inesperado respondem 200 sem gravar", async () => {
    expect((await post(update({ keyId: "WA1", status: "SERVER_ACK" }))).statusCode).toBe(200);
    expect((await post(update({}))).statusCode).toBe(200);
    expect(m.applyMessageDeliveryStatus).not.toHaveBeenCalled();
  });
  it("falha do banco ou instância desconhecida nunca vira erro para o Evolution", async () => {
    m.applyMessageDeliveryStatus.mockRejectedValue(new Error("db"));
    expect((await post(update({ keyId: "WA1", status: "READ" }))).statusCode).toBe(200);
    m.getInstanceByInstanceId.mockRejectedValue(new Error("unknown"));
    expect((await post(update({ keyId: "WA1", status: "READ" }))).statusCode).toBe(200);
  });
});
