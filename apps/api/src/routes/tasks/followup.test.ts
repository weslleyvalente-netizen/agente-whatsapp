import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const {
  getAdminClient,
  getTaskById,
  getOrganizationById,
  getAgentById,
  getOpportunityById,
  getRecentMessages,
  getQualificationByConversationId,
  setFollowupSuggestion,
  incrementFollowupRegenerationCount,
} = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  getTaskById: vi.fn(),
  getOrganizationById: vi.fn(),
  getAgentById: vi.fn(),
  getOpportunityById: vi.fn(),
  getRecentMessages: vi.fn().mockResolvedValue([]),
  getQualificationByConversationId: vi.fn().mockResolvedValue(null),
  setFollowupSuggestion: vi.fn(),
  incrementFollowupRegenerationCount: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAdminClient,
  getTaskById,
  getOrganizationById,
  getAgentById,
  getOpportunityById,
  getRecentMessages,
  getQualificationByConversationId,
  setFollowupSuggestion,
  incrementFollowupRegenerationCount,
}));

const { resolveApiKey, generateTaskFollowupSuggestion } = vi.hoisted(() => ({
  resolveApiKey: vi.fn().mockResolvedValue("api-key-1"),
  generateTaskFollowupSuggestion: vi.fn(),
}));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey, generateTaskFollowupSuggestion }));

const { resolveTaskFollowupEligibility, sendTaskFollowup, getFollowupTouchInfo } = vi.hoisted(() => ({
  resolveTaskFollowupEligibility: vi.fn(),
  sendTaskFollowup: vi.fn(),
  getFollowupTouchInfo: vi.fn(),
}));
vi.mock("../../services/task-followup.service.js", () => ({
  resolveTaskFollowupEligibility,
  sendTaskFollowup,
  getFollowupTouchInfo,
}));

vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { id: "user-1", email: "u@example.com", memberships: [{ organization_id: "org-1", role: "admin" }] };
  },
}));

import taskRoutes from "./index.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
  return app;
}

const conversation = { id: "conv-1", agent_id: "agent-1", organization_id: "org-1" } as any;
const task = {
  id: "task-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  conversation_id: "conv-1",
  opportunity_id: null,
  type: "proposal_followup",
  description: "Cliente sumiu",
  followup_suggested_message: null,
  followup_regeneration_count: 0,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  getTaskById.mockResolvedValue(task);
  getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_followup_enabled: true } });
  getAgentById.mockResolvedValue({ id: "agent-1", provider: "anthropic", model: "claude-sonnet-5" });
  resolveTaskFollowupEligibility.mockResolvedValue({ eligible: true, conversation });
  getFollowupTouchInfo.mockResolvedValue({ lastTouchAt: null, lastTouchBy: null, touchCount: 0 });
});

describe("POST /tasks/:taskId/followup-suggestion", () => {
  it("generates a first suggestion, stores it, and does not count it as a regeneration", async () => {
    generateTaskFollowupSuggestion.mockResolvedValue({ message: "Oi! Ainda pensando na proposta?" });
    setFollowupSuggestion.mockResolvedValue({ ...task, followup_suggested_message: "Oi! Ainda pensando na proposta?" });

    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ message: "Oi! Ainda pensando na proposta?", regenerationsRemaining: 5 });
    expect(incrementFollowupRegenerationCount).not.toHaveBeenCalled();

    await app.close();
  });

  // Point 4d: the panel shows the last touch and touch count before the
  // attendant even sends anything.
  it("includes the touch info (last touch + count) in the response", async () => {
    getFollowupTouchInfo.mockResolvedValue({ lastTouchAt: "2026-09-29T10:00:00Z", lastTouchBy: "agent", touchCount: 1 });
    generateTaskFollowupSuggestion.mockResolvedValue({ message: "Oi!" });
    setFollowupSuggestion.mockResolvedValue({});

    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion" });

    expect(response.json()).toMatchObject({
      touch: { lastTouchAt: "2026-09-29T10:00:00Z", lastTouchBy: "agent", touchCount: 1 },
    });

    await app.close();
  });

  it("increments the regeneration count when a suggestion already exists (Gerar outra)", async () => {
    getTaskById.mockResolvedValue({ ...task, followup_suggested_message: "Sugestão antiga", followup_regeneration_count: 2 });
    generateTaskFollowupSuggestion.mockResolvedValue({ message: "Nova sugestão" });
    setFollowupSuggestion.mockResolvedValue({});
    incrementFollowupRegenerationCount.mockResolvedValue({});

    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion", payload: { regenerate: true } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ message: "Nova sugestão", regenerationsRemaining: 2 });
    expect(incrementFollowupRegenerationCount).toHaveBeenCalledWith({}, "task-1", 3);

    await app.close();
  });

  it("returns 429 when the regeneration limit was already reached", async () => {
    getTaskById.mockResolvedValue({ ...task, followup_suggested_message: "Sugestão antiga", followup_regeneration_count: 5 });

    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion", payload: { regenerate: true } });

    expect(response.statusCode).toBe(429);
    expect(generateTaskFollowupSuggestion).not.toHaveBeenCalled();

    await app.close();
  });

  it("reopening uses the saved suggestion even at the limit, without charging a regeneration", async () => {
    getTaskById.mockResolvedValue({ ...task, followup_suggested_message: "Texto salvo", followup_regeneration_count: 5 });
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ message: "Texto salvo", regenerationsRemaining: 0 });
    expect(generateTaskFollowupSuggestion).not.toHaveBeenCalled();
    expect(incrementFollowupRegenerationCount).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps the old suggestion and quota on a generation failure", async () => {
    getTaskById.mockResolvedValue({ ...task, followup_suggested_message: "Texto anterior", followup_regeneration_count: 2 });
    generateTaskFollowupSuggestion.mockResolvedValue({ message: "Texto padrão", generated: false });
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion", payload: { regenerate: true } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ reason: "generation_failed", regenerationsRemaining: 3 });
    expect(setFollowupSuggestion).not.toHaveBeenCalled();
    expect(incrementFollowupRegenerationCount).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes the prior suggestion when asking for a different approach", async () => {
    getTaskById.mockResolvedValue({ ...task, followup_suggested_message: "Sugestão anterior" });
    generateTaskFollowupSuggestion.mockResolvedValue({ message: "Nova abordagem", generated: true });
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion", payload: { regenerate: true } });
    expect(response.statusCode).toBe(200);
    expect(generateTaskFollowupSuggestion).toHaveBeenCalledWith(expect.objectContaining({ previousMessage: "Sugestão anterior" }));
    await app.close();
  });

  it("returns 400 when the task is not eligible for follow-up", async () => {
    resolveTaskFollowupEligibility.mockResolvedValue({ eligible: false, reason: "not_eligible_type" });

    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion" });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("returns 403 when the requesting user is not a member of the task's organization", async () => {
    getTaskById.mockResolvedValue({ ...task, organization_id: "org-2" });

    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion" });

    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it("returns 404 when task_followup_enabled is off for the organization", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });

    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/followup-suggestion" });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});

describe("POST /tasks/:taskId/send-followup", () => {
  it("returns 200 with the completed task on the happy path", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: true, task: { ...task, status: "completed" } });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi! Vamos fechar?" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ task: { status: "completed" } });

    await app.close();
  });

  it("returns 400 for a validation error (empty message)", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/tasks/task-1/send-followup", payload: { message: "" } });

    expect(response.statusCode).toBe(400);
    expect(sendTaskFollowup).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 429 with retryAfterSeconds when throttled by min_interval", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: false, reason: "min_interval", retryAfterSeconds: 12 });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ retryAfterSeconds: 12 });

    await app.close();
  });

  it("returns 429 when throttled by daily_limit", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: false, reason: "daily_limit" });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(429);

    await app.close();
  });

  it("returns 400 when the task is not eligible", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: false, reason: "not_eligible", detail: "no_conversation" });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("returns 502 when the send itself failed", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: false, reason: "send_failed", detail: "Evolution API down" });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(502);

    await app.close();
  });

  // Point 4: coordination blocks — 409 with canForce, never silently retried.
  it("returns 409 with canForce when blocked by a recent touch", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: false, reason: "recent_touch", hoursSinceTouch: 1.5 });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "recent_touch", hoursSinceTouch: 1.5, canForce: true });

    await app.close();
  });

  it("returns 409 with suggestMarkLost when the touch limit was reached", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: false, reason: "touch_limit_reached", touchCount: 3 });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "touch_limit_reached", touchCount: 3, suggestMarkLost: true, canForce: true });

    await app.close();
  });

  // Point 2: confirmation flow — 409, never mapped to 500/502 (not a failure).
  it("returns 409 with canForce when the send is unconfirmed", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: false, reason: "unconfirmed", pendingMessageId: "msg-pending-1" });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "unconfirmed", pendingMessageId: "msg-pending-1", canForce: true });

    await app.close();
  });

  it("passes force through to sendTaskFollowup", async () => {
    sendTaskFollowup.mockResolvedValue({ ok: true, task: { ...task, status: "completed" } });

    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!", force: true },
    });

    expect(sendTaskFollowup).toHaveBeenCalledWith(expect.objectContaining({ force: true }));

    await app.close();
  });

  it("returns 403 when the requesting user is not a member of the task's organization", async () => {
    getTaskById.mockResolvedValue({ ...task, organization_id: "org-2" });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(403);
    expect(sendTaskFollowup).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 404 when task_followup_enabled is off for the organization", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/tasks/task-1/send-followup",
      payload: { message: "Oi!" },
    });

    expect(response.statusCode).toBe(404);
    expect(sendTaskFollowup).not.toHaveBeenCalled();

    await app.close();
  });
});
