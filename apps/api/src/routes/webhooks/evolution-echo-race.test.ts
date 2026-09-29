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
const findPendingOutboundMessages = vi.fn();
const setMessageEvolutionId = vi.fn();

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  getInstanceByInstanceId: (...args: unknown[]) => getInstanceByInstanceId(...args),
  updateConversation: (...args: unknown[]) => updateConversation(...args),
  getIgnoredContact: (...args: unknown[]) => getIgnoredContact(...args),
  createHandoffEvent: (...args: unknown[]) => createHandoffEvent(...args),
  getOrganizationById: (...args: unknown[]) => getOrganizationById(...args),
  findPendingOutboundMessages: (...args: unknown[]) => findPendingOutboundMessages(...args),
  setMessageEvolutionId: (...args: unknown[]) => setMessageEvolutionId(...args),
}));

const ensureConversation = vi.fn();
vi.mock("../../services/conversation.service.js", () => ({
  ensureConversation: (...args: unknown[]) => ensureConversation(...args),
}));

// saveMessage must NOT be reached at all when a pending match is found —
// these tests assert it's never called, proving the race guard short-
// circuits before the exact-id idempotency check even runs.
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

function fromMePayload(overrides: Partial<{ content: string; messageType: string; message: Record<string, unknown> }> = {}) {
  return {
    event: "messages.upsert",
    instance: "instance-name",
    data: {
      key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: true, id: "EVO-NEW-1" },
      message: overrides.message ?? { conversation: overrides.content ?? "Oi! Ainda pensando na proposta?" },
      messageType: overrides.messageType ?? "conversation",
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
  findPendingOutboundMessages.mockResolvedValue([]);
});

describe("evolution webhook — echo race guard (arrives before backfill)", () => {
  it("matches a pending human_agent text send and skips everything, without ever calling saveMessage", async () => {
    findPendingOutboundMessages.mockResolvedValue([
      { id: "pending-1", role: "human_agent", content: "Oi! Ainda pensando na proposta?", media_type: null, created_at: "2026-09-29T11:59:00Z" },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload({ content: "Oi! Ainda pensando na proposta?" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, skipped: "duplicate", messageId: "pending-1" });
    expect(setMessageEvolutionId).toHaveBeenCalledWith({}, "pending-1", "EVO-NEW-1");
    expect(saveMessage).not.toHaveBeenCalled();
    expect(updateConversation).not.toHaveBeenCalled();
    expect(handleConversationTakeover).not.toHaveBeenCalled();

    await app.close();
  });

  // Point 1a: Helena's own reply (role "agent") echoes back the exact same
  // way a human's does — without this guard, its own echo racing the
  // backfill would be saved as a brand-new role=human_agent message and
  // wrongly activate takeover on top of the AI's own conversation.
  it("matches a pending agent (Helena's own) text send and does not activate takeover", async () => {
    findPendingOutboundMessages.mockResolvedValue([
      { id: "pending-agent-1", role: "agent", content: "Posso te ajudar com mais alguma coisa?", media_type: null, created_at: "2026-09-29T11:59:30Z" },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload({ content: "Posso te ajudar com mais alguma coisa?" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, skipped: "duplicate", messageId: "pending-agent-1" });
    expect(setMessageEvolutionId).toHaveBeenCalledWith({}, "pending-agent-1", "EVO-NEW-1");
    expect(updateConversation).not.toHaveBeenCalled();
    expect(handleConversationTakeover).not.toHaveBeenCalled();
    expect(createHandoffEvent).not.toHaveBeenCalled();

    await app.close();
  });

  // Point 1b: the echo's extracted content for outbound audio is a fixed
  // "[audio]" placeholder (never our real TTS text) — must match by
  // media_type alone.
  it("matches a pending audio (TTS) send by media_type alone, ignoring content", async () => {
    findPendingOutboundMessages.mockResolvedValue([
      { id: "pending-audio-1", role: "agent", content: "texto do TTS que nunca aparece no eco", media_type: "audio", created_at: "2026-09-29T11:59:45Z" },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload({ messageType: "audioMessage", message: { audioMessage: { seconds: 3 } } }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, skipped: "duplicate", messageId: "pending-audio-1" });
    expect(setMessageEvolutionId).toHaveBeenCalledWith({}, "pending-audio-1", "EVO-NEW-1");

    await app.close();
  });

  // Point 1b: image caption echoes back for real, but still matched by
  // media_type per the shared matcher's design (robust either way).
  it("matches a pending image send with a caption", async () => {
    findPendingOutboundMessages.mockResolvedValue([
      { id: "pending-image-1", role: "agent", content: "FZ15 Fazer ABS Connected", media_type: "image", created_at: "2026-09-29T11:59:50Z" },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload({
        messageType: "imageMessage",
        message: { imageMessage: { caption: "FZ15 Fazer ABS Connected" } },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, skipped: "duplicate", messageId: "pending-image-1" });

    await app.close();
  });

  // Point 1c: ties resolve to the oldest pending candidate.
  it("matches the oldest of two identical pending candidates", async () => {
    findPendingOutboundMessages.mockResolvedValue([
      { id: "pending-newer", role: "human_agent", content: "Oi!", media_type: null, created_at: "2026-09-29T11:59:50Z" },
      { id: "pending-older", role: "human_agent", content: "Oi!", media_type: null, created_at: "2026-09-29T11:58:00Z" },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload({ content: "Oi!" }),
    });

    expect(response.json()).toMatchObject({ messageId: "pending-older" });

    await app.close();
  });

  it("falls through to normal processing when no pending candidate matches (genuinely new fromMe message)", async () => {
    findPendingOutboundMessages.mockResolvedValue([
      { id: "pending-1", role: "human_agent", content: "Texto completamente diferente", media_type: null, created_at: "2026-09-29T11:59:00Z" },
    ]);
    saveMessage.mockResolvedValue({ id: "msg-real" });
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload({ content: "vamos prosseguir com a compra da Bros" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, source: "fromMe" });
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(setMessageEvolutionId).not.toHaveBeenCalled();

    await app.close();
  });
});
