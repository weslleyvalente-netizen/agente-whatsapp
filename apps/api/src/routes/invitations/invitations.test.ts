import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("@aula-agente/database", () => ({ getAdminClient: () => state.db }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async () => {} }));
import Fastify from "fastify";
import routes from "./index.js";

type Row = Record<string, any>;
/** Minimal in-memory Supabase fake: selects/inserts/updates over arrays, plus auth.admin.generateLink. */
function fakeDb(opts: { invitations?: Row[]; members?: Row[]; generateLink?: () => Promise<any> } = {}) {
  const tables: Record<string, Row[]> = { organization_invitations: opts.invitations ?? [], organization_members: opts.members ?? [] };
  const inserts: Array<[string, Row]> = [];
  const updates: Array<[string, Row, string]> = [];
  const db = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let pending: any = null;
      const q: any = {
        select: () => q,
        eq: (k: string, v: any) => { filters.push(r => r[k] === v); return q; },
        gt: (k: string, v: any) => { filters.push(r => r[k] > v); return q; },
        ilike: (k: string, v: string) => { const needle = v.replace(/\\(.)/g, "$1").toLowerCase(); filters.push(r => String(r[k]).toLowerCase() === needle); return q; },
        limit: () => q,
        maybeSingle: async () => ({ data: tables[table].filter(r => filters.every(f => f(r)))[0] ?? null, error: null }),
        single: async () => ({ data: pending, error: null }),
        insert: (row: Row) => { const withId = { id: `${table}-${tables[table].length + 1}`, ...row }; tables[table].push(withId); inserts.push([table, row]); pending = withId; return q; },
        update: (patch: Row) => ({ eq: async (_k: string, id: string) => { const row = tables[table].find(r => r.id === id); if (row) Object.assign(row, patch); updates.push([table, patch, id]); return { error: null }; } }),
        then: (resolve: any) => resolve({ data: tables[table].filter(r => filters.every(f => f(r))), error: null }),
      };
      return q;
    },
    auth: { admin: { generateLink: opts.generateLink ?? (async () => ({ data: { properties: { hashed_token: "HASH123" } }, error: null })) } },
  };
  return { db, tables, inserts, updates };
}

async function app(role: string, user: { id?: string; email?: string } = {}) {
  const f = Fastify();
  f.addHook("preHandler", async (req: any) => {
    req.user = { id: user.id ?? "u1", email: user.email ?? "gestor@x.com", memberships: [{ organization_id: "org", role }] };
  });
  await f.register(routes);
  return f;
}
const invite = (f: any, payload: any, headers: any = { origin: "https://app.test" }) =>
  f.inject({ method: "POST", url: "/organizations/org/invitations", payload, headers });
beforeEach(() => { delete process.env.WEB_APP_URL; });

describe("POST /organizations/:id/invitations", () => {
  it("só owner/admin convidam; vendedor e não-membro recebem 403", async () => {
    state.db = fakeDb().db;
    expect((await invite(await app("agent"), { email: "a@x.com" })).statusCode).toBe(403);
    const f = Fastify(); f.addHook("preHandler", async (req: any) => { req.user = { id: "u", email: "u@x.com", memberships: [] }; }); await f.register(routes);
    expect((await invite(f, { email: "a@x.com" })).statusCode).toBe(403);
  });

  it("valida e-mail e papel", async () => {
    state.db = fakeDb().db;
    expect((await invite(await app("admin"), { email: "nao-e-email" })).statusCode).toBe(400);
    expect((await invite(await app("admin"), { email: "a@x.com", role: "owner" })).statusCode).toBe(400);
  });

  it("registra o convite em minúsculas e devolve um link de uso único com o token_hash", async () => {
    const f = fakeDb(); state.db = f.db;
    const res = await invite(await app("owner"), { email: "  Marina.Silva@Gmail.com " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userExists: false, inviteLink: "https://app.test/accept-invite?token_hash=HASH123&type=invite" });
    expect(f.inserts[0][1]).toMatchObject({ organization_id: "org", email: "marina.silva@gmail.com", role: "agent", invited_by: "u1", status: "pending" });
  });

  it("não duplica um convite pendente e reaproveita o existente", async () => {
    const f = fakeDb({ invitations: [{ id: "inv1", organization_id: "org", email: "a@x.com", status: "pending", expires_at: "2999-01-01" }] }); state.db = f.db;
    const res = await invite(await app("admin"), { email: "A@x.com" });
    expect(res.json().invitationId).toBe("inv1");
    expect(f.inserts).toHaveLength(0);
  });

  it("quando a pessoa já tem login, não devolve link e avisa", async () => {
    const f = fakeDb({ generateLink: async () => ({ data: null, error: { code: "email_exists", message: "A user with this email address has already been registered" } }) });
    state.db = f.db;
    const res = await invite(await app("admin"), { email: "a@x.com" });
    expect(res.json()).toMatchObject({ inviteLink: null, userExists: true });
  });

  it("usa WEB_APP_URL quando definida e falha com clareza sem nenhuma URL", async () => {
    state.db = fakeDb().db;
    process.env.WEB_APP_URL = "https://crm.exemplo.com/";
    expect((await invite(await app("admin"), { email: "a@x.com" }, {})).json().inviteLink).toMatch(/^https:\/\/crm\.exemplo\.com\/accept-invite\?token_hash=/);
    delete process.env.WEB_APP_URL;
    expect((await invite(await app("admin"), { email: "b@x.com" }, {})).statusCode).toBe(500);
  });
});

describe("POST /invitations/accept", () => {
  const accept = (f: any) => f.inject({ method: "POST", url: "/invitations/accept" });
  const pendingInvite = (over: Row = {}) => ({ id: "inv1", organization_id: "org", email: "marina@x.com", role: "agent", status: "pending", expires_at: "2999-01-01T00:00:00Z", ...over });

  it("adiciona à organização com o papel do convite e marca como aceito", async () => {
    const f = fakeDb({ invitations: [pendingInvite()] }); state.db = f.db;
    const res = await accept(await app("agent", { id: "marina-id", email: "Marina@X.com" }));
    expect(res.json()).toEqual({ accepted: 1, organizationIds: ["org"] });
    expect(f.inserts.find(([t]) => t === "organization_members")![1]).toEqual({ organization_id: "org", user_id: "marina-id", role: "agent" });
    expect(f.tables.organization_invitations[0].status).toBe("accepted");
  });

  it("ignora convite expirado, de outro e-mail ou já aceito", async () => {
    const f = fakeDb({ invitations: [pendingInvite({ expires_at: "2000-01-01T00:00:00Z" }), pendingInvite({ id: "inv2", email: "outro@x.com" }), pendingInvite({ id: "inv3", status: "accepted" })] });
    state.db = f.db;
    const res = await accept(await app("agent", { id: "marina-id", email: "marina@x.com" }));
    expect(res.json()).toEqual({ accepted: 0, organizationIds: [] });
    expect(f.inserts).toHaveLength(0);
  });

  it("é idempotente: quem já é membro não é duplicado, e o convite é concluído", async () => {
    const f = fakeDb({ invitations: [pendingInvite()], members: [{ id: "m1", organization_id: "org", user_id: "marina-id" }] }); state.db = f.db;
    const res = await accept(await app("agent", { id: "marina-id", email: "marina@x.com" }));
    expect(res.json().accepted).toBe(1);
    expect(f.inserts.filter(([t]) => t === "organization_members")).toHaveLength(0);
    expect(f.tables.organization_invitations[0].status).toBe("accepted");
  });

  it("usuário sem e-mail recebe 400", async () => {
    state.db = fakeDb().db;
    const f = Fastify(); f.addHook("preHandler", async (req: any) => { req.user = { id: "u", email: "", memberships: [] }; }); await f.register(routes);
    expect((await accept(f)).statusCode).toBe(400);
  });
});
