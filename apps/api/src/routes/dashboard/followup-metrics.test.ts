import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const {
  getAdminClient,
  getConversationStatusesByOrganization,
  getMessagesForDashboard,
  getHumanTakeoverConversations,
  getRecentMessages,
  getPendingHandoffs,
  getOrganizationById,
  getOpenTasksWithScoreInputs,
  getFollowupMetrics,
} = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  getConversationStatusesByOrganization: vi.fn().mockResolvedValue([]),
  getMessagesForDashboard: vi.fn().mockResolvedValue([]),
  getHumanTakeoverConversations: vi.fn().mockResolvedValue([]),
  getRecentMessages: vi.fn().mockResolvedValue([]),
  getPendingHandoffs: vi.fn().mockResolvedValue([]),
  getOrganizationById: vi.fn().mockResolvedValue({ id: "org-1", settings: {} }),
  getOpenTasksWithScoreInputs: vi.fn().mockResolvedValue([]),
  getFollowupMetrics: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAdminClient,
  getConversationStatusesByOrganization,
  getMessagesForDashboard,
  getHumanTakeoverConversations,
  getRecentMessages,
  getPendingHandoffs,
  getOrganizationById,
  getOpenTasksWithScoreInputs,
  getFollowupMetrics,
}));

vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { id: "user-1", email: "u@example.com", memberships: [{ organization_id: "org-1", role: "admin" }] };
  },
}));

import dashboardRoutes from "./index.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(dashboardRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
  getFollowupMetrics.mockResolvedValue({ total: 12, original: 5, edited: 7 });
});

describe("GET /organizations/:organizationId/followups/metrics", () => {
  it("returns the aggregated metrics for the default window", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/organizations/org-1/followups/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ total: 12, original: 5, edited: 7 });
    expect(getFollowupMetrics).toHaveBeenCalledWith({}, "org-1", expect.any(String));

    await app.close();
  });

  it("returns 403 when the user is not a member of the organization", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/organizations/org-2/followups/metrics" });

    expect(response.statusCode).toBe(403);
    expect(getFollowupMetrics).not.toHaveBeenCalled();

    await app.close();
  });
});
