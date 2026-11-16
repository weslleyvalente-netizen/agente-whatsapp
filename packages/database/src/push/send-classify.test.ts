// Formatos REAIS do web-push 3.6.x: usa webpush.sendNotification de verdade (criptografia, VAPID, WebPushError, "Socket timeout"),
// trocando só o transporte (https.request) para devolver respostas/erros de rede controlados. Nenhuma requisição sai da máquina.
import { EventEmitter } from "node:events";
import https from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPushError, sendPushToUser } from "./send.js";

const b64u = (b: Buffer) => b.toString("base64url");
function realSubscription(id: string) {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  return { id, endpoint: `https://push.example.test/${id}`, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) };
}
const vapid = webpush.generateVAPIDKeys();
const ENV = { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:ensaio@example.test" };

type Behavior = { status: number } | { error: { code?: string; message?: string } } | { timeout: true };
/** Simula o servidor/rede por trás do https.request que o web-push chama. */
function stubTransport(byEndpointSuffix: Record<string, Behavior>) {
  return vi.spyOn(https, "request").mockImplementation(((options: any, cb: (res: any) => void) => {
    const req: any = new EventEmitter();
    req.write = () => true;
    req.destroy = (err?: Error) => { process.nextTick(() => req.emit("error", err)); };
    req.end = () => {
      const key = Object.keys(byEndpointSuffix).find(k => String(options.path).endsWith(k))!;
      const b = byEndpointSuffix[key];
      process.nextTick(() => {
        if ("status" in b) {
          const res: any = new EventEmitter(); res.statusCode = b.status; res.headers = { "retry-after": "5" };
          cb(res); res.emit("data", "corpo"); res.emit("end");
        } else if ("error" in b) {
          const e: any = new Error(b.error.message ?? b.error.code); if (b.error.code) e.code = b.error.code; req.emit("error", e);
        } else req.emit("timeout"); // o web-push responde com destroy(new Error("Socket timeout"))
      });
    };
    return req;
  }) as never);
}
const dbWith = (subs: ReturnType<typeof realSubscription>[]) => {
  const deleted: string[] = [];
  const db: any = {
    from: () => ({
      select: () => { const c: any = { eq: () => c, then: (res: any) => res({ data: subs, error: null }) }; return c; },
      delete: () => ({ in: async (_c: string, ids: string[]) => { deleted.push(...ids); return { error: null }; } }),
    }),
  };
  return { db, deleted };
};
const payload = { title: "t", body: "b", url: "/x", tag: "tag" };
afterEach(() => vi.restoreAllMocks());

/** Chama o web-push REAL para um endpoint e devolve o erro (ou null se aceito). */
async function realError(b: Behavior) {
  const s = realSubscription("e"); stubTransport({ "/e": b });
  try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, "x", { vapidDetails: { subject: ENV.VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 60, timeout: 50 }); return null; }
  catch (e) { return e; }
}

describe("classifyPushError sobre erros REAIS do web-push", () => {
  it("201/2xx: aceito (não é erro)", async () => { expect(await realError({ status: 201 })).toBeNull(); });
  it.each([404, 410])("%i => gone (assinatura expirada)", async status => {
    const e = await realError({ status }); expect((e as any).name).toBe("WebPushError"); expect(classifyPushError(e)).toBe("gone");
  });
  it.each([400, 401, 403, 413, 429])("%i => not_sent (o provedor respondeu rejeitando)", async status => {
    const e = await realError({ status }); expect((e as any).statusCode).toBe(status); expect(classifyPushError(e)).toBe("not_sent");
  });
  it.each([408, 500, 502, 503, 504])("%i => ambiguous (resposta de infraestrutura: não prova que nada foi aceito)", async status => {
    expect(classifyPushError(await realError({ status }))).toBe("ambiguous");
  });
  it.each(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"])("rede pré-conexão %s => not_sent (nada chegou ao provedor)", async code => {
    expect(classifyPushError(await realError({ error: { code } }))).toBe("not_sent");
  });
  it.each(["ECONNRESET", "EPIPE", "ETIMEDOUT"])("rede no meio da requisição %s => ambiguous", async code => {
    expect(classifyPushError(await realError({ error: { code } }))).toBe("ambiguous");
  });
  it("timeout do socket (a resposta pode ter se perdido) => ambiguous", async () => {
    const e = await realError({ timeout: true }); expect((e as Error).message).toBe("Socket timeout"); expect(classifyPushError(e)).toBe("ambiguous");
  });
  it("erro desconhecido, nulo ou sem forma => ambiguous (padrão conservador)", () => {
    expect(classifyPushError(new Error("algo"))).toBe("ambiguous");
    expect(classifyPushError(null)).toBe("ambiguous");
    expect(classifyPushError(undefined)).toBe("ambiguous");
    expect(classifyPushError({})).toBe("ambiguous");
  });
});

describe("sendPushToUser com mais de um dispositivo (web-push real, transporte simulado)", () => {
  const run = async (behaviors: Behavior[]) => {
    const subs = behaviors.map((_, i) => realSubscription(`d${i}`));
    stubTransport(Object.fromEntries(subs.map((s, i) => [`/${s.id}`, behaviors[i]])));
    const { db, deleted } = dbWith(subs);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sendPushToUser(db, "u", payload, { env: ENV });
    return { r, deleted };
  };
  it("todos aceitos", async () => { expect((await run([{ status: 201 }, { status: 201 }])).r).toMatchObject({ sent: 2, failed: 0, ambiguous: 0 }); });
  it("um aceito e um ambíguo: sent=1, failed=1, ambiguous=1 (o destinatário conta como entregue)", async () => {
    expect((await run([{ status: 201 }, { timeout: true }])).r).toMatchObject({ sent: 1, failed: 1, ambiguous: 1 });
  });
  it("um rejeitado (400) e um ambíguo (timeout): nenhum aceito, 1 ambíguo", async () => {
    expect((await run([{ status: 400 }, { timeout: true }])).r).toMatchObject({ sent: 0, failed: 2, ambiguous: 1 });
  });
  it("todos rejeitados de forma definitiva (400 e DNS): nenhum ambíguo", async () => {
    expect((await run([{ status: 400 }, { error: { code: "ENOTFOUND" } }])).r).toMatchObject({ sent: 0, failed: 2, ambiguous: 0 });
  });
  it("um expirado (410) é removido e não conta como falha; o outro aceito", async () => {
    const { r, deleted } = await run([{ status: 410 }, { status: 201 }]);
    expect(r).toMatchObject({ sent: 1, removed: 1, failed: 0, ambiguous: 0 }); expect(deleted).toEqual(["d0"]);
  });
  it("5xx e ECONNRESET contam como ambíguos", async () => {
    expect((await run([{ status: 503 }, { error: { code: "ECONNRESET" } }])).r).toMatchObject({ sent: 0, failed: 2, ambiguous: 2 });
  });
});
