import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

// Deterministic regardless of the environment this suite runs in —
// webhookVerifyMiddleware skips verification entirely when unset.
delete process.env.WEBHOOK_SECRET;

const getInstanceByInstanceId = vi.fn();
const updateConversation = vi.fn();
const getIgnoredContact = vi.fn();
const createHandoffEvent = vi.fn();
const getOrganizationById = vi.fn();

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  getInstanceByInstanceId: (...args: unknown[]) => getInstanceByInstanceId(...args),
  updateConversation: (...args: unknown[]) => updateConversation(...args),
  getIgnoredContact: (...args: unknown[]) => getIgnoredContact(...args),
  createHandoffEvent: (...args: unknown[]) => createHandoffEvent(...args),
  getOrganizationById: (...args: unknown[]) => getOrganizationById(...args),
}));

const ensureConversation = vi.fn();
vi.mock("../../services/conversation.service.js", () => ({
  ensureConversation: (...args: unknown[]) => ensureConversation(...args),
}));

const saveMessage = vi.fn();
vi.mock("../../services/message.service.js", () => ({
  saveMessage: (...args: unknown[]) => saveMessage(...args),
}));

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

const openConversation = { id: "conv-1", is_human_takeover: false };
const contact = { id: "contact-1", ai_disabled: false };

beforeEach(() => {
  vi.clearAllMocks();
  getInstanceByInstanceId.mockResolvedValue({ id: "instance-db-1", organization_id: "org-1", active_agent_id: "agent-1" });
  getIgnoredContact.mockResolvedValue(null);
  ensureConversation.mockResolvedValue({ conversation: openConversation, contact, isNew: false });
  saveMessage.mockResolvedValue({ id: "msg-1" });
  getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
  createHandoffEvent.mockResolvedValue({ id: "handoff-1" });
});

describe("evolution webhook — fromMe greeting filter (Fase 1)", () => {
  // The requirement this test exists for: a fromMe message the greeting
  // filter catches must never reach the AI pipeline — no process-message
  // job, no takeover activation, no task reassignment. It's still saved and
  // will show up in the history sent to the model on the customer's own
  // next message (see the "Notas operacionais" prompt section), but it must
  // not itself trigger a reply or silence the agent.
  it("does NOT enqueue process-message, activate takeover, or reassign tasks for a filtered greeting", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload("Bom dia"),
    });

    expect(response.statusCode).toBe(200);
    expect(enqueueProcessMessage).not.toHaveBeenCalled();
    expect(updateConversation).not.toHaveBeenCalled();
    expect(handleConversationTakeover).not.toHaveBeenCalled();
    expect(createHandoffEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ trigger_type: "fromMe_greeting_filtered" })
    );

    await app.close();
  });

  it("DOES activate takeover (and never enqueues process-message either) for a real fromMe message", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload("vamos prosseguir com a compra da Bros, temos pronta entrega"),
    });

    expect(response.statusCode).toBe(200);
    expect(updateConversation).toHaveBeenCalledWith({}, "conv-1", expect.objectContaining({ is_human_takeover: true }));
    expect(handleConversationTakeover).toHaveBeenCalledWith({}, "org-1", "conv-1", null);
    expect(createHandoffEvent).toHaveBeenCalledWith({}, expect.objectContaining({ trigger_type: "fromMe_real" }));
    // fromMe never enqueues the AI regardless of content — the branch
    // returns before ever reaching that code path.
    expect(enqueueProcessMessage).not.toHaveBeenCalled();

    await app.close();
  });

  it("keeps refreshing takeover for a bare greeting once already in an active takeover (no new handoff_events row)", async () => {
    ensureConversation.mockResolvedValue({
      conversation: { id: "conv-1", is_human_takeover: true },
      contact,
      isNew: false,
    });

    const app = await buildApp();
    await app.inject({ method: "POST", url: "/webhooks/evolution", payload: fromMePayload("Bom dia") });

    expect(updateConversation).toHaveBeenCalledWith({}, "conv-1", expect.objectContaining({ is_human_takeover: true }));
    // Not a NEW episode, so no handoff_events row (decision from the plan:
    // only log when it would have avoided a new takeover).
    expect(createHandoffEvent).not.toHaveBeenCalled();
    // Already in takeover before this message, so this isn't a first
    // takeover — task reassignment doesn't re-run either.
    expect(handleConversationTakeover).not.toHaveBeenCalled();

    await app.close();
  });
});
