import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

// Deterministic regardless of the environment this suite runs in —
// webhookVerifyMiddleware skips verification entirely when unset.
delete process.env.WEBHOOK_SECRET;

const resolveUnresponsiveTasksOnReply = vi.fn().mockResolvedValue(undefined);
const getInstanceByInstanceId = vi.fn();
const updateConversation = vi.fn();
const getIgnoredContact = vi.fn();
const createHandoffEvent = vi.fn();
const getOrganizationById = vi.fn();

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: (...args: unknown[]) => resolveUnresponsiveTasksOnReply(...args),
  getInstanceByInstanceId: (...args: unknown[]) => getInstanceByInstanceId(...args),
  updateConversation: (...args: unknown[]) => updateConversation(...args),
  getIgnoredContact: (...args: unknown[]) => getIgnoredContact(...args),
  createHandoffEvent: (...args: unknown[]) => createHandoffEvent(...args),
  getOrganizationById: (...args: unknown[]) => getOrganizationById(...args),
  // The echo race guard (evolution-echo-race.test.ts covers it directly) —
  // no pending candidate here, so it always falls through to saveMessage.
  findPendingOutboundMessages: async () => [],
  setMessageEvolutionId: async () => undefined,
}));
vi.mock("../../services/waiting-on-sync.js", () => ({ syncWaitingOnAfterSellerMessage: (...a: unknown[]) => syncSeller(...a), syncWaitingOnAfterCustomerReply: vi.fn() }));

const ensureConversation = vi.fn();
vi.mock("../../services/conversation.service.js", () => ({
  ensureConversation: (...args: unknown[]) => ensureConversation(...args),
}));

const saveMessage = vi.fn();
vi.mock("../../services/message.service.js", () => ({
  saveMessage: (...args: unknown[]) => saveMessage(...args),
}));

const syncSeller = vi.fn().mockResolvedValue("no_change");

const handleConversationTakeover = vi.fn();
vi.mock("../../services/task.service.js", () => ({
  handleConversationTakeover: (...args: unknown[]) => handleConversationTakeover(...args),
}));

const enqueueProcessMessage = vi.fn();
vi.mock("../../lib/queue.js", () => ({
  enqueueProcessMessage: (...args: unknown[]) => enqueueProcessMessage(...args),
}));

const syncContactToCrm = vi.fn();
vi.mock("../../integrations/crm-sync.js", () => ({
  syncContactToCrm: (...args: unknown[]) => syncContactToCrm(...args),
}));

async function buildApp() {
  const app = Fastify();
  await app.register(evolutionWebhookRoutes);
  return app;
}

function fromMePayload(content: string) {
  return {
    event: "messages.upsert",
    instance: "instance-name",
    data: {
      key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: true, id: "evo-msg-1" },
      message: { conversation: content },
      messageType: "conversation",
    },
  };
}

const openConversation = { id: "conv-1", contact_id: "contact-1", is_human_takeover: false };
const contact = { id: "contact-1", ai_disabled: false };

beforeEach(() => {
  vi.clearAllMocks();
  getInstanceByInstanceId.mockResolvedValue({ id: "instance-db-1", organization_id: "org-1", active_agent_id: "agent-1" });
  getIgnoredContact.mockResolvedValue(null);
  ensureConversation.mockResolvedValue({ conversation: openConversation, contact, isNew: false });
  saveMessage.mockResolvedValue({ id: "msg-1" });
  // Fase 1's greeting filter ships OFF by default (safe rollout) — these
  // tests are specifically about the filter's own behavior, so the org
  // fixture opts in explicitly, the same way a real org would from
  // Configurações. A separate test below covers the off-by-default case.
  getOrganizationById.mockResolvedValue({ id: "org-1", settings: { takeover_greeting_filter_enabled: true } });
  createHandoffEvent.mockResolvedValue({ id: "handoff-1" });
});

describe("evolution webhook — fromMe alimenta a sincronização de waiting_on", () => {
  it("mensagem do vendedor pelo celular chama a sincronização com negócio/contato, texto e id da mensagem", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: fromMePayload("consórcio 40.000 61 x 575,95, esse ficaria bom pra você?") });
    expect(response.statusCode).toBe(200);
    expect(syncSeller).toHaveBeenCalledTimes(1);
    expect(syncSeller).toHaveBeenCalledWith({}, expect.objectContaining({ organizationId: "org-1", contactId: "contact-1", role: "human_agent", content: "consórcio 40.000 61 x 575,95, esse ficaria bom pra você?", messageId: "msg-1" }));
    await app.close();
  });
  it("contato ignorado nunca aciona a sincronização", async () => {
    getIgnoredContact.mockResolvedValue({ id: "ig", retention_mode: "minimal_record" });
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/webhooks/evolution", payload: fromMePayload("entrada R$ 8.000, 56x R$ 535") });
    expect(syncSeller).not.toHaveBeenCalled();
    await app.close();
  });
  it("eco de mensagem duplicada (já salva) não aciona a sincronização de novo", async () => {
    saveMessage.mockResolvedValue(null);
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/webhooks/evolution", payload: fromMePayload("entrada R$ 8.000, 56x R$ 535") });
    expect(syncSeller).not.toHaveBeenCalled();
    await app.close();
  });
});
