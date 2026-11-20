import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ resolve: vi.fn(), avatar: vi.fn(), setPic: vi.fn() }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveWhatsAppTarget: m.resolve, uazapiAvatarUrl: m.avatar }));
vi.mock("@aula-agente/database", () => ({ getInstanceById: async () => ({ instance_name: "w" }), setContactProfilePicture: m.setPic }));

import { fetchContactProfilePicture } from "./profile-picture.js";

describe("foto de perfil pela UAZAPI", () => {
  it("sem foto (null): marca a tentativa e não baixa nada", async () => {
    m.resolve.mockResolvedValue({ provider: "uazapi", instanceName: "w", token: "tok" });
    m.avatar.mockResolvedValue(null);
    const downloadImage = vi.fn();
    const r = await fetchContactProfilePicture({} as any, { organizationId: "o", contactId: "c", instanceId: "i", phone: "556299" } as any, { downloadImage });
    expect(r).toEqual({ ok: true, stored: false });
    expect(m.avatar).toHaveBeenCalledWith("tok", "556299");
    expect(downloadImage).not.toHaveBeenCalled();
    expect(m.setPic).toHaveBeenCalledWith({}, "c", null);
  });
});
