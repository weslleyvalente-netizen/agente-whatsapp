import { describe, expect, it, vi } from "vitest";
import { sendPushToUser, isPushConfigured } from "./send.js";

const ENV = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:a@b.c" };
const sub = (id: string) => ({ id, endpoint: `https://push.example/${id}`, p256dh: "k", auth: "a" });

function fakeDb(subs: ReturnType<typeof sub>[]) {
  const deleted: string[] = [];
  const filters: Array<[string, unknown]> = [];
  const db = {
    from: (table: string) => {
      expect(table).toBe("push_subscriptions");
      return {
        select: () => {
          const c: any = { eq: (col: string, v: unknown) => { filters.push([col, v]); return c; }, then: (res: any) => res({ data: subs, error: null }) };
          return c;
        },
        delete: () => ({ in: async (_c: string, ids: string[]) => { deleted.push(...ids); return { error: null }; } }),
      };
    },
  } as any;
  return { db, deleted, filters };
}
const payload = { title: "t", body: "b", url: "/inbox", tag: "x" };

describe("isPushConfigured", () => {
  it("exige as três variáveis", () => {
    expect(isPushConfigured(ENV)).toBe(true);
    expect(isPushConfigured({ ...ENV, VAPID_PRIVATE_KEY: "" })).toBe(false);
    expect(isPushConfigured({})).toBe(false);
  });
});

describe("sendPushToUser", () => {
  it("sem chaves VAPID fica inerte: não consulta nem envia", async () => {
    const send = vi.fn();
    const db = { from: vi.fn() } as any;
    const r = await sendPushToUser(db, "u", payload, { env: {}, send });
    expect(r).toEqual({ sent: 0, removed: 0, failed: 0, skipped: true });
    expect(send).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("filtra as assinaturas pela organização quando informada", async () => {
    const { db, filters } = fakeDb([sub("1")]);
    await sendPushToUser(db, "u", payload, { env: ENV, send: vi.fn().mockResolvedValue({}), organizationId: "org-1" });
    expect(filters).toEqual([["user_id", "u"], ["organization_id", "org-1"]]);
  });

  it("envia a todas as assinaturas", async () => {
    const { db } = fakeDb([sub("1"), sub("2")]);
    const send = vi.fn().mockResolvedValue({});
    const r = await sendPushToUser(db, "u", payload, { env: ENV, send });
    expect(r).toMatchObject({ sent: 2, removed: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0][1])).toEqual(payload);
  });

  it("410 e 404 apagam a assinatura; falha de um endpoint não impede os outros", async () => {
    const { db, deleted } = fakeDb([sub("gone"), sub("missing"), sub("boom"), sub("ok")]);
    const send = vi.fn(async (s: any) => {
      if (s.endpoint.endsWith("gone")) throw { statusCode: 410 };
      if (s.endpoint.endsWith("missing")) throw { statusCode: 404 };
      if (s.endpoint.endsWith("boom")) throw { statusCode: 500, message: "x" };
      return {};
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sendPushToUser(db, "u", payload, { env: ENV, send });
    expect(r).toMatchObject({ sent: 1, removed: 2, failed: 1 });
    expect(deleted.sort()).toEqual(["gone", "missing"]);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("push.example");
    log.mockRestore();
  });
});
