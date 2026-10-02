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
  // Fase 1's greeting filter ships OFF by default (safe rollout) — these
  // tests are specifically about the filter's own behavior, so the org
  // fixture opts in explicitly, the same way a real org would from
  // Configurações. A separate test below covers the off-by-default case.
  getOrganizationById.mockResolvedValue({ id: "org-1", settings: { takeover_greeting_filter_enabled: true } });
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

  // Deploy safety (explicitly requested): the migrations for
  // organization_ignored_contacts / handoff_events might not be applied yet
  // when this code first deploys — a lookup failure on either must never
  // take down message processing for every other contact.
  it("still processes a normal fromMe message when the ignored-contacts lookup fails (missing table, etc.)", async () => {
    getIgnoredContact.mockRejectedValue(new Error('relation "organization_ignored_contacts" does not exist'));

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload("vamos prosseguir com a compra da Bros"),
    });

    expect(response.statusCode).toBe(200);
    expect(updateConversation).toHaveBeenCalledWith({}, "conv-1", expect.objectContaining({ is_human_takeover: true }));

    await app.close();
  });

  it("still activates takeover for a filtered greeting even when recording the handoff_events row fails", async () => {
    createHandoffEvent.mockRejectedValue(new Error('relation "handoff_events" does not exist'));

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: fromMePayload("Bom dia"),
    });

    expect(response.statusCode).toBe(200);
    // The greeting filter itself still works — takeover stays skipped —
    // even though logging the metric failed.
    expect(updateConversation).not.toHaveBeenCalled();

    await app.close();
  });

  // Deploy-safety requirement: the greeting filter ships disabled by
  // default (DEFAULT_GREETING_FILTER_ENABLED = false) — an org that never
  // visits Configurações must see the exact same behavior as before Fase 1.
  it("activates takeover for a bare greeting when the org hasn't opted into the greeting filter (default off)", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });

    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: fromMePayload("Bom dia") });

    expect(response.statusCode).toBe(200);
    expect(updateConversation).toHaveBeenCalledWith({}, "conv-1", expect.objectContaining({ is_human_takeover: true }));
    expect(handleConversationTakeover).toHaveBeenCalled();

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

describe("incoming reply task resolution",()=>{
 for(const mode of ["takeover","ai_disabled"]){
  it(`resolves persisted inbound replies even during ${mode}`,async()=>{
   ensureConversation.mockResolvedValue({conversation:{...openConversation,is_human_takeover:mode==="takeover"},contact:{...contact,ai_disabled:mode==="ai_disabled"},isNew:false});
   saveMessage.mockResolvedValue({id:"reply",role:"contact",created_at:"2026-10-02T16:00:00Z"});
   const payload=fromMePayload("Amanhã retorno");payload.data.key.fromMe=false;
   const app=await buildApp();const response=await app.inject({method:"POST",url:"/webhooks/evolution",payload});
   expect(response.statusCode).toBe(200);expect(resolveUnresponsiveTasksOnReply).toHaveBeenCalledWith({},expect.objectContaining({organizationId:"org-1",conversationId:"conv-1",contactId:"contact-1",role:"contact",messageId:"reply"}));
   expect(enqueueProcessMessage).not.toHaveBeenCalled();await app.close();
  });
 }
 it("does not treat outbound or duplicate webhooks as new customer replies",async()=>{
  const app=await buildApp();await app.inject({method:"POST",url:"/webhooks/evolution",payload:fromMePayload("Bom dia")});
  expect(resolveUnresponsiveTasksOnReply).not.toHaveBeenCalled();
  saveMessage.mockResolvedValue(null);const payload=fromMePayload("Ok");payload.data.key.fromMe=false;
  await app.inject({method:"POST",url:"/webhooks/evolution",payload});expect(resolveUnresponsiveTasksOnReply).not.toHaveBeenCalled();await app.close();
 });
});
