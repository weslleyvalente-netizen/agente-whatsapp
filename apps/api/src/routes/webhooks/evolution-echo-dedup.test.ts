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

// saveMessage is the layer that actually owns the idempotency check (see
// message.service.test.ts for that in isolation) — here it's mocked to
// return null, simulating "this evolution_message_id was already saved",
// which is exactly what happens once the send-message worker backfills the
// real id (apps/worker/src/workers/send-message.ts) and its echo arrives.
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

function echoPayload() {
  return {
    event: "messages.upsert",
    instance: "instance-name",
    data: {
      key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: true, id: "EVO-123" },
      message: { conversation: "Já te retorno com as condições!" },
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
});

describe("evolution webhook — echo of our own outbound message (dedup)", () => {
  // Regression for the bug found while planning the task-followup feature:
  // every message sent via /messages/send (and, by extension, the new
  // send-followup-from-task flow) used to be saved with
  // evolution_message_id: null, so when its own echo came back through this
  // webhook with fromMe: true, saveMessage's idempotency check never found
  // it and created a duplicate row — while still running takeover/handoff
  // bookkeeping a second time. Now that the worker backfills the real id,
  // saveMessage recognizes the echo (returns null) and this branch must
  // skip everything below it.
  it("recognizes an already-saved echo and skips takeover/handoff bookkeeping entirely", async () => {
    saveMessage.mockResolvedValue(null); // simulates messageExistsByEvolutionId matching

    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: echoPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, skipped: "duplicate" });

    expect(updateConversation).not.toHaveBeenCalled();
    expect(handleConversationTakeover).not.toHaveBeenCalled();
    expect(createHandoffEvent).not.toHaveBeenCalled();
    expect(getOrganizationById).not.toHaveBeenCalled();
    expect(enqueueProcessMessage).not.toHaveBeenCalled();

    await app.close();
  });

  it("processes normally (not skipped) when the echo's id was not seen before", async () => {
    saveMessage.mockResolvedValue({ id: "msg-real" });
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });

    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: echoPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, source: "fromMe" });
    expect(updateConversation).toHaveBeenCalledWith({}, "conv-1", expect.objectContaining({ is_human_takeover: true }));

    await app.close();
  });
});
