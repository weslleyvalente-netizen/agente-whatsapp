import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

// Distribuição de leads: a mensagem do vendedor pelo celular (eco fromMe) marca a primeira resposta e assume o lead.
// Uma saudação curta ("Bom dia") nunca assume, mesmo com o takeover já ativo (o requestHuman sempre o liga antes).
delete process.env.WEBHOOK_SECRET;

const getInstanceByInstanceId = vi.fn();
const updateConversation = vi.fn();
const getIgnoredContact = vi.fn();
const createHandoffEvent = vi.fn();
const getOrganizationById = vi.fn();
const recordHumanMessage = vi.fn();

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: (...args: unknown[]) => getInstanceByInstanceId(...args),
  updateConversation: (...args: unknown[]) => updateConversation(...args),
  getIgnoredContact: (...args: unknown[]) => getIgnoredContact(...args),
  createHandoffEvent: (...args: unknown[]) => createHandoffEvent(...args),
  getOrganizationById: (...args: unknown[]) => getOrganizationById(...args),
  getOpenHandoffEvent: async () => null,
  markFirstHumanReply: async () => undefined,
  findPendingOutboundMessages: async () => [],
  setMessageEvolutionId: async () => undefined,
  recordHumanMessage: (...args: unknown[]) => recordHumanMessage(...args),
}));

const ensureConversation = vi.fn();
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: (...args: unknown[]) => ensureConversation(...args) }));
const saveMessage = vi.fn();
vi.mock("../../services/message.service.js", () => ({ saveMessage: (...args: unknown[]) => saveMessage(...args) }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: async () => undefined }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

async function buildApp() {
  const app = Fastify();
  await app.register(evolutionWebhookRoutes);
  return app;
}

const fromMe = (content: string) => ({
  event: "messages.upsert",
  instance: "instance-name",
  data: { key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: true, id: "evo-msg-1" }, message: { conversation: content }, messageType: "conversation" },
});

const send = async (content: string) => {
  const app = await buildApp();
  const response = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: fromMe(content) });
  await app.close();
  return response;
};

beforeEach(() => {
  vi.clearAllMocks();
  getInstanceByInstanceId.mockResolvedValue({ id: "instance-db-1", organization_id: "org-1", active_agent_id: "agent-1" });
  getIgnoredContact.mockResolvedValue(null);
  // Lead distribuído: o requestHuman já ativou o takeover; o vendedor tem o lead pendente.
  ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: true }, contact: { id: "contact-1", ai_disabled: false }, isNew: false });
  saveMessage.mockResolvedValue({ id: "msg-1" });
  getOrganizationById.mockResolvedValue({ id: "org-1", settings: { takeover_greeting_filter_enabled: true, lead_distribution_enabled: true } });
  createHandoffEvent.mockResolvedValue({ id: "handoff-1" });
  recordHumanMessage.mockResolvedValue("assign-1");
});

describe("evolution webhook — fromMe e aceite do lead (distribuição)", () => {
  it("saudação curta com takeover já ativo NÃO chama recordHumanMessage (não assume o lead)", async () => {
    const response = await send("Bom dia");
    expect(response.statusCode).toBe(200);
    expect(recordHumanMessage).not.toHaveBeenCalled();
    // O takeover continua sendo renovado como hoje (comportamento de takeover inalterado).
    expect(updateConversation).toHaveBeenCalledWith({}, "conv-1", expect.objectContaining({ is_human_takeover: true }));
  });

  it("uma frase de verdade chama recordHumanMessage como phone_echo, sem autor", async () => {
    await send("Oi, aqui é a Marina, vou te passar a simulação da Fazer agora");
    expect(recordHumanMessage).toHaveBeenCalledWith({}, expect.objectContaining({ organizationId: "org-1", conversationId: "conv-1", authorUserId: null, via: "phone_echo" }));
  });

  it("saudação no início de um episódio novo continua filtrada (não assume) como já era", async () => {
    ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "contact-1", ai_disabled: false }, isNew: false });
    await send("Bom dia");
    expect(recordHumanMessage).not.toHaveBeenCalled();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  it("contato ignorado com registro mínimo nunca chama recordHumanMessage", async () => {
    getIgnoredContact.mockResolvedValue({ id: "ig-1", retention_mode: "minimal_record" });
    const response = await send("Oi, aqui é a Marina, vou te passar a simulação da Fazer agora");
    expect(response.statusCode).toBe(200);
    expect(recordHumanMessage).not.toHaveBeenCalled();
  });
});
