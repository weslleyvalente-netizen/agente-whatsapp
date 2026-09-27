import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { getAdminClient, getAgentById, uploadAgentImage } = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  getAgentById: vi.fn(),
  uploadAgentImage: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ getAdminClient, getAgentById }));
vi.mock("../../services/agent-media.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/agent-media.service.js")>()),
  uploadAgentImage,
}));

let role = "admin";
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { id: "user-1", email: "u@example.com", memberships: [{ organization_id: "org-1", role }] };
  },
}));

import agentImageRoutes from "./images.js";
import { InvalidImageError } from "../../services/agent-media.service.js";

const URL_ = "/organizations/org-1/agents/agent-1/config/images";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function multipart(file: Buffer | null) {
  const boundary = "----testboundary";
  const parts = file
    ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="catalogo.png"\r\nContent-Type: image/png\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`)]
    : [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nx\r\n--${boundary}--\r\n`)];
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(agentImageRoutes);
  await app.ready();
  return app;
}

describe("POST agent config images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role = "admin";
    getAgentById.mockResolvedValue({ id: "agent-1", organization_id: "org-1" });
  });

  it("uploads and returns 201 with id/url/storage_path", async () => {
    uploadAgentImage.mockResolvedValue({ id: "u1", url: "https://x.test/a.png", storage_path: "org-1/agent-1/u1.png" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(PNG) });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: "u1", url: "https://x.test/a.png", storage_path: "org-1/agent-1/u1.png" });
    expect(uploadAgentImage).toHaveBeenCalledWith({}, { organizationId: "org-1", agentId: "agent-1", file: PNG });
  });

  it("returns 400 without a file", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(null) });
    expect(res.statusCode).toBe(400);
    expect(uploadAgentImage).not.toHaveBeenCalled();
  });

  it("returns 400 with the service's message for an invalid image", async () => {
    uploadAgentImage.mockRejectedValue(new InvalidImageError("Formato não suportado: envie PNG, JPG ou WebP."));
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(PNG) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("PNG, JPG ou WebP");
  });

  it("returns 404 when the agent belongs to another organization", async () => {
    getAgentById.mockResolvedValue({ id: "agent-1", organization_id: "org-2" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(PNG) });
    expect(res.statusCode).toBe(404);
    expect(uploadAgentImage).not.toHaveBeenCalled();
  });

  it("returns 403 for the agent role", async () => {
    role = "agent";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(PNG) });
    expect(res.statusCode).toBe(403);
  });

  it("returns 413 above 5 MB", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL_, ...multipart(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])) });
    expect(res.statusCode).toBe(413);
    expect(uploadAgentImage).not.toHaveBeenCalled();
  });
});
