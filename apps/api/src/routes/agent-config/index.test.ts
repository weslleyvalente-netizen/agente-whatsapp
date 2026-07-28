import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const {
  getAdminClient, getAgentById, patchAgentConfig,
  createPlaygroundSession, getPlaygroundMessages, getPlaygroundSessionById,
  createTrainerSession, getTrainerSessionById, getTrainerMessages, addTrainerMessage,
} = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  getAgentById: vi.fn(),
  patchAgentConfig: vi.fn(),
  createPlaygroundSession: vi.fn(),
  getPlaygroundMessages: vi.fn(),
  getPlaygroundSessionById: vi.fn(),
  createTrainerSession: vi.fn(),
  getTrainerSessionById: vi.fn(),
  getTrainerMessages: vi.fn(),
  addTrainerMessage: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAdminClient, getAgentById, patchAgentConfig,
  createPlaygroundSession, getPlaygroundMessages, getPlaygroundSessionById,
  createTrainerSession, getTrainerSessionById, getTrainerMessages, addTrainerMessage,
}));

const { proposeConfigChange } = vi.hoisted(() => ({ proposeConfigChange: vi.fn() }));
vi.mock("../../services/trainer.service.js", () => ({ proposeConfigChange }));

const { applyTrainerProposal, rejectTrainerProposal } = vi.hoisted(() => ({
  applyTrainerProposal: vi.fn(),
  rejectTrainerProposal: vi.fn(),
}));
vi.mock("../../services/trainer-decisions.service.js", () => ({ applyTrainerProposal, rejectTrainerProposal }));

vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { id: "user-1", email: "u@example.com", memberships: [{ organization_id: "org-1", role: "admin" }] };
  },
}));

import agentConfigRoutes from "./index.js";

const agent = { id: "agent-1", organization_id: "org-1", system_prompt: "" };
const session = { id: "session-1", agent_id: "agent-1", organization_id: "org-1", created_by: "user-1", created_at: "2026-01-01T00:00:00Z" };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(agentConfigRoutes);
  await app.ready();
  return app;
}

describe("trainer proposal apply/reject routes — error status mapping", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    getAdminClient.mockReturnValue({});
    getAgentById.mockResolvedValue(agent);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("apply returns 403 (not 409) when the proposal belongs to a different agent's session", async () => {
    applyTrainerProposal.mockRejectedValue(new Error("Proposal does not belong to this agent"));

    const res = await app.inject({ method: "POST", url: "/agents/agent-1/trainer/proposals/proposal-1/apply" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Proposal does not belong to this agent" });
  });

  it("reject returns 403 (not 409) when the proposal belongs to a different agent's session", async () => {
    rejectTrainerProposal.mockRejectedValue(new Error("Proposal does not belong to this agent"));

    const res = await app.inject({ method: "POST", url: "/agents/agent-1/trainer/proposals/proposal-1/reject" });

    expect(res.statusCode).toBe(403);
  });

  it("apply returns 404 for a nonexistent proposal id", async () => {
    applyTrainerProposal.mockRejectedValue(new Error("Proposal not found"));

    const res = await app.inject({ method: "POST", url: "/agents/agent-1/trainer/proposals/missing/apply" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Proposal not found" });
  });

  it("reject returns 404 for a nonexistent proposal id", async () => {
    rejectTrainerProposal.mockRejectedValue(new Error("Proposal not found"));

    const res = await app.inject({ method: "POST", url: "/agents/agent-1/trainer/proposals/missing/reject" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Proposal not found" });
  });

  it("apply on an already-decided proposal still returns 409", async () => {
    applyTrainerProposal.mockRejectedValue(new Error("Proposal already decided"));

    const res = await app.inject({ method: "POST", url: "/agents/agent-1/trainer/proposals/proposal-1/apply" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Proposal already decided" });
  });

  it("apply on a proposal with unresolved conflicts still returns 409", async () => {
    applyTrainerProposal.mockRejectedValue(new Error("Cannot apply a proposal with unresolved conflicts"));

    const res = await app.inject({ method: "POST", url: "/agents/agent-1/trainer/proposals/proposal-1/apply" });

    expect(res.statusCode).toBe(409);
  });

  it("apply succeeds and returns the applied proposal", async () => {
    const proposal = { id: "proposal-1", status: "applied" };
    applyTrainerProposal.mockResolvedValue({ proposal, draft: { id: "draft-1" } });

    const res = await app.inject({ method: "POST", url: "/agents/agent-1/trainer/proposals/proposal-1/apply" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(proposal);
  });
});

describe("POST /agents/:agentId/trainer/sessions/:sessionId/messages — proposeConfigChange failure", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    getAdminClient.mockReturnValue({});
    getAgentById.mockResolvedValue(agent);
    getTrainerSessionById.mockResolvedValue(session);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("persists the user's message even when proposeConfigChange throws, then surfaces the error", async () => {
    proposeConfigChange.mockRejectedValue(new Error("LLM upstream timeout"));
    addTrainerMessage.mockResolvedValue({ id: "msg-1", role: "user", content: "hello" });

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/trainer/sessions/session-1/messages",
      payload: { content: "hello" },
    });

    // The request as a whole fails...
    expect(res.statusCode).not.toBe(201);
    // ...but the user's message was persisted anyway, before the error was surfaced.
    expect(addTrainerMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sessionId: "session-1",
        organizationId: "org-1",
        role: "user",
        content: "hello",
      })
    );
    // Only the user message was persisted — no assistant message, since
    // proposeConfigChange never produced one.
    expect(addTrainerMessage).toHaveBeenCalledTimes(1);
  });

  it("persists both the user and assistant messages on success, in that order", async () => {
    proposeConfigChange.mockResolvedValue({ content: "Sure, done.", proposals: [] });
    addTrainerMessage
      .mockResolvedValueOnce({ id: "msg-user", role: "user", content: "hello" })
      .mockResolvedValueOnce({ id: "msg-assistant", role: "assistant", content: "Sure, done." });

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/trainer/sessions/session-1/messages",
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(201);
    expect(addTrainerMessage).toHaveBeenCalledTimes(2);
    expect(addTrainerMessage).toHaveBeenNthCalledWith(1, {}, expect.objectContaining({ role: "user", content: "hello" }));
    expect(addTrainerMessage).toHaveBeenNthCalledWith(2, {}, expect.objectContaining({ role: "assistant", content: "Sure, done." }));
  });

  it("passes analyzeConversations straight through, defaulting to false when the client omits it", async () => {
    proposeConfigChange.mockResolvedValue({ content: "ok", proposals: [] });
    addTrainerMessage.mockResolvedValue({ id: "msg-1" });

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/trainer/sessions/session-1/messages",
      payload: { content: "melhora o tom da conversa" },
    });
    // Omitted -> false. The word "conversa" in the message must not opt the
    // user into a scan of real customer messages.
    expect(proposeConfigChange).toHaveBeenLastCalledWith({}, "agent-1", "session-1", "melhora o tom da conversa", false);

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/trainer/sessions/session-1/messages",
      payload: { content: "sugira melhorias", analyzeConversations: true },
    });
    expect(proposeConfigChange).toHaveBeenLastCalledWith({}, "agent-1", "session-1", "sugira melhorias", true);
  });

  it("rejects a non-boolean analyzeConversations with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/trainer/sessions/session-1/messages",
      payload: { content: "oi", analyzeConversations: "sim" },
    });

    expect(res.statusCode).toBe(400);
    expect(proposeConfigChange).not.toHaveBeenCalled();
  });
});
