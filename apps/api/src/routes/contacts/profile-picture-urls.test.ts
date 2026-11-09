import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  role: { value: "agent" }, settings: { value: {} as Record<string, boolean> }, memberOrg: { value: "org-1" },
  contacts: { value: [] as Array<Record<string, unknown>> }, convs: { value: [] as Array<Record<string, unknown>> },
  getOrganizationById: vi.fn(), listSalesReps: vi.fn(), createSignedUrls: vi.fn(), storageFrom: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getOrganizationById: m.getOrganizationById, listSalesReps: m.listSalesReps,
  getAdminClient: () => ({
    storage: { from: m.storageFrom },
    from: (table: string) => ({
      select: () => ({
        in: () => {
          const result = { data: table === "wa_contacts" ? m.contacts.value : m.convs.value, error: null };
          return { limit: async () => result, then: (res: (v: typeof result) => unknown) => res(result) };
        },
      }),
    }),
  }),
}));
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (req: any) => { req.user = { id: MARINA, memberships: [{ organization_id: m.memberOrg.value, role: m.role.value }] }; },
}));
import profilePictureUrlsRoutes from "./profile-picture-urls.js";

const MARINA = "22222222-2222-4222-8222-222222222222"; const MARCIO = "33333333-3333-4333-8333-333333333333";
const C1 = "11111111-1111-4111-8111-111111111111"; const C2 = "44444444-4444-4444-8444-444444444444";

async function post(body: unknown) {
  const app = Fastify(); await app.register(profilePictureUrlsRoutes);
  const r = await app.inject({ method: "POST", url: "/contacts/profile-picture-urls", payload: body as object }); await app.close(); return r;
}
const contact = (id: string, org = "org-1", path: string | null = `${org}/${id}.jpg`) => ({ id, organization_id: org, profile_picture_path: path });

beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent"; m.settings.value = { seller_isolation_enabled: true }; m.memberOrg.value = "org-1";
  m.contacts.value = [contact(C1)]; m.convs.value = [];
  m.getOrganizationById.mockImplementation(async () => ({ settings: m.settings.value }));
  m.listSalesReps.mockResolvedValue([{ user_id: MARINA }, { user_id: MARCIO }]);
  m.createSignedUrls.mockImplementation(async (paths: string[]) => ({
    data: paths.map((p) => ({ path: p, signedUrl: `https://signed.example/${p}?t=1`, error: null })), error: null,
  }));
  m.storageFrom.mockReturnValue({ createSignedUrls: m.createSignedUrls });
});

describe("POST /contacts/profile-picture-urls", () => {
  it("devolve link assinado (3600 s) do bucket profile-pictures", async () => {
    const r = await post({ contact_ids: [C1] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ urls: { [C1]: `https://signed.example/org-1/${C1}.jpg?t=1` } });
    expect(m.storageFrom).toHaveBeenCalledWith("profile-pictures");
    expect(m.createSignedUrls).toHaveBeenCalledWith([`org-1/${C1}.jpg`], 3600);
  });

  it("body inválido -> 400", async () => {
    for (const body of [{}, { contact_ids: [] }, { contact_ids: ["x"] }, { contact_ids: "a" }]) {
      expect((await post(body)).statusCode).toBe(400);
    }
  });

  it("mais de 100 ids -> 400", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect((await post({ contact_ids: ids })).statusCode).toBe(400);
  });

  it("contato de organização da qual o usuário não é membro -> ausente", async () => {
    m.contacts.value = [contact(C1, "org-2")];
    const r = await post({ contact_ids: [C1] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ urls: {} });
    expect(m.createSignedUrls).not.toHaveBeenCalled();
  });

  it("contato sem foto -> ausente", async () => {
    m.contacts.value = [contact(C1, "org-1", null)];
    expect((await post({ contact_ids: [C1] })).json()).toEqual({ urls: {} });
    expect(m.createSignedUrls).not.toHaveBeenCalled();
  });

  it("caminho forjado (de outra organização/contato) -> ausente e nunca assinado", async () => {
    m.contacts.value = [
      contact(C1, "org-1", `org-2/${C1}.jpg`),
      contact(C2, "org-1", `org-1/${C1}.jpg`),
      contact("55555555-5555-4555-8555-555555555555", "org-1", `org-1/../org-2/x.jpg`),
    ];
    const r = await post({ contact_ids: [C1, C2, "55555555-5555-4555-8555-555555555555"] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ urls: {} });
    expect(m.createSignedUrls).not.toHaveBeenCalled();
  });

  it("vendedor com isolamento: conversa de outro vendedor -> ausente; própria -> presente", async () => {
    m.contacts.value = [contact(C1), contact(C2)];
    m.convs.value = [
      { contact_id: C1, organization_id: "org-1", assigned_to: MARCIO },
      { contact_id: C2, organization_id: "org-1", assigned_to: MARINA },
    ];
    const r = await post({ contact_ids: [C1, C2] });
    expect(Object.keys(r.json().urls)).toEqual([C2]);
  });

  it("basta uma conversa visível; gestor e contato sem conversa passam", async () => {
    m.convs.value = [
      { contact_id: C1, organization_id: "org-1", assigned_to: MARCIO },
      { contact_id: C1, organization_id: "org-1", assigned_to: MARINA },
    ];
    expect(Object.keys((await post({ contact_ids: [C1] })).json().urls)).toEqual([C1]);
    m.convs.value = [{ contact_id: C1, organization_id: "org-1", assigned_to: MARCIO }];
    m.role.value = "owner";
    expect(Object.keys((await post({ contact_ids: [C1] })).json().urls)).toEqual([C1]);
    m.role.value = "agent"; m.convs.value = [];
    expect(Object.keys((await post({ contact_ids: [C1] })).json().urls)).toEqual([C1]);
  });

  it("leitura de conversas no teto (possível truncamento): contato sem conversa carregada -> ausente", async () => {
    m.contacts.value = [contact(C1), contact(C2)];
    m.convs.value = Array.from({ length: 1000 }, () => ({ contact_id: C2, organization_id: "org-1", assigned_to: MARINA }));
    const r = await post({ contact_ids: [C1, C2] });
    expect(Object.keys(r.json().urls)).toEqual([C2]);
  });

  it("erro ao assinar um item ou o lote -> ausente, 200", async () => {
    m.contacts.value = [contact(C1), contact(C2)];
    m.createSignedUrls.mockResolvedValueOnce({
      data: [{ path: `org-1/${C1}.jpg`, signedUrl: null, error: "x" }, { path: `org-1/${C2}.jpg`, signedUrl: "https://s/2", error: null }], error: null,
    });
    const r = await post({ contact_ids: [C1, C2] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ urls: { [C2]: "https://s/2" } });
    m.createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const r2 = await post({ contact_ids: [C1] });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ urls: {} });
  });
});
