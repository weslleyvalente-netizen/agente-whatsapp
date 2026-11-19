// Aviso de exceção ao gestor: reserva de idempotência no PostgreSQL REAL (pglite) com a DDL de produção, runPushSweep e
// claimPushDedupe/sendPushToUser reais. Só as fontes de candidatos e o provedor de push (web-push) são simulados.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const src = vi.hoisted(() => ({
  listPushEnabledOrganizationIds: vi.fn(), listNewAssignmentCandidates: vi.fn(), listCustomerMessageCandidates: vi.fn(), listSlaRiskCandidates: vi.fn(),
  listSlaBreachCandidates: vi.fn(), listSlaEscalationOrganizationIds: vi.fn(), listExceptionCandidates: vi.fn(), listExceptionPushOrganizationIds: vi.fn(),
}));
vi.mock("@aula-agente/database", async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...src }));
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getPushNotificationsQueue: () => ({ upsertJobScheduler: vi.fn() }) }));
import { claimPushDedupe } from "@aula-agente/database";
import { runPushSweep, createPushCursor } from "./push-notifications.js";

const ORG = "o";
const DONO = "11111111-1111-4111-8111-111111111111";
const GESTOR = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-11-19T15:00:00Z");
let pg: PGlite;

/** DDL real de produção: o CREATE TABLE da migração de push (sem inventar a tabela). */
function productionDdl(): string {
  const sql = readFileSync(new URL("../../../../supabase/migrations/20261018120000_push_notifications.sql", import.meta.url), "utf8");
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS public.push_notification_log");
  return sql.slice(start, sql.indexOf(");", start) + 2);
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
/** Cliente do Supabase em cima do PostgreSQL real, só com as chamadas que o push usa. upsert+ignoreDuplicates do PostgREST = ON CONFLICT DO NOTHING RETURNING. */
function makeDb(subs: Record<string, Sub[]>, opts: { failSubscriptionRead?: () => boolean } = {}) {
  const chain = (run: () => Promise<{ data: unknown; error: unknown }>) => { const c: any = { eq: () => c, in: () => c, then: (res: any, rej: any) => run().then(res, rej) }; return c; };
  return {
    from(table: string) {
      if (table === "push_notification_log") {
        return {
          upsert: (row: { dedupe_key: string; user_id: string }) => ({
            select: async () => ({ data: (await pg.query("insert into public.push_notification_log(dedupe_key,user_id) values ($1,$2) on conflict (dedupe_key) do nothing returning dedupe_key", [row.dedupe_key, row.user_id])).rows, error: null }),
          }),
          delete: () => ({
            in: async (_c: string, keys: string[]) => { await pg.query("delete from public.push_notification_log where dedupe_key = any($1)", [keys]); return { error: null }; },
            lt: async (_c: string, iso: string) => { await pg.query("delete from public.push_notification_log where created_at < $1", [iso]); return { error: null }; },
          }),
        };
      }
      if (table === "organization_members") return { select: () => ({ eq: () => ({ in: async (_c: string, ids: string[]) => ({ data: ids.map((user_id) => ({ user_id })), error: null }) }) }) };
      if (table === "push_subscriptions") {
        return {
          select: () => { let user = ""; const c: any = { eq: (col: string, v: string) => { if (col === "user_id") user = v; return c; }, then: (res: any, rej: any) => Promise.resolve(opts.failSubscriptionRead?.() ? { data: null, error: { message: "db fora do ar" } } : { data: subs[user] ?? [], error: null }).then(res, rej) }; return c; },
          delete: () => ({ in: async () => ({ error: null }), eq: () => ({ eq: async () => ({ error: null }) }) }),
        };
      }
      return chain(async () => ({ data: [], error: null }));
    },
  } as any;
}

const exception = (id: string, manager: string) => ({
  kind: "exception", organizationId: ORG, userId: manager, dedupeKeys: [`exception:${id}:${manager}`], title: "Cliente sem dono: Claudivan", body: "b", url: "/opportunities?conversa=c1", tag: "exception-c1",
});
const device = (id: string): Sub => ({ id, endpoint: `https://push.example/${id}`, p256dh: "p", auth: "a" });

beforeAll(async () => {
  process.env.VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv"; process.env.VAPID_SUBJECT = "mailto:x@example.com";
  pg = new PGlite();
  await pg.exec(productionDdl());
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec("delete from public.push_notification_log");
  src.listPushEnabledOrganizationIds.mockResolvedValue([ORG]);
  for (const k of ["listNewAssignmentCandidates", "listCustomerMessageCandidates"] as const) src[k].mockResolvedValue({ candidates: [], truncatedAt: null });
  for (const k of ["listSlaRiskCandidates", "listSlaBreachCandidates", "listExceptionCandidates"] as const) src[k].mockResolvedValue([]);
  src.listSlaEscalationOrganizationIds.mockResolvedValue([]);
  src.listExceptionPushOrganizationIds.mockResolvedValue([ORG]);
});

describe("reserva de idempotência no PostgreSQL real", () => {
  it("a DDL de produção tem chave primária em dedupe_key (base da reserva atômica)", async () => {
    const r = await pg.query<{ contype: string }>("select contype from pg_constraint where conrelid = 'public.push_notification_log'::regclass");
    expect(r.rows.map((x) => x.contype)).toContain("p");
  });

  it("20 reservas simultâneas da MESMA chave: exatamente uma ganha; chaves de outros gestores são independentes", async () => {
    const db = makeDb({});
    const same = await Promise.all(Array.from({ length: 20 }, () => claimPushDedupe(db, `exception:e1:${DONO}`, DONO)));
    expect(same.filter(Boolean)).toHaveLength(1);
    expect(await claimPushDedupe(db, `exception:e1:${GESTOR}`, GESTOR)).toBe(true);
    expect(await claimPushDedupe(db, `exception:e1:${DONO}`, DONO)).toBe(false);
    expect((await pg.query("select count(*)::int as n from public.push_notification_log")).rows[0]).toEqual({ n: 2 });
  });

  it("a reserva sobrevive a reinício do worker (cursor novo) e a varreduras repetidas: cada gestor recebe uma vez", async () => {
    const sent: string[] = [];
    const send = vi.fn(async (sub: { endpoint: string }) => { sent.push(sub.endpoint); });
    const db = makeDb({ [DONO]: [device("d1")], [GESTOR]: [device("g1")] });
    src.listExceptionCandidates.mockResolvedValue([exception("e1", DONO), exception("e1", GESTOR)]);
    for (let i = 0; i < 3; i++) await runPushSweep(db, createPushCursor(now), new Date(now.getTime() + i * 30_000), { send });
    expect(sent.sort()).toEqual(["https://push.example/d1", "https://push.example/g1"]);
  });

  it("nova entrada em exceção (linha nova) avisa de novo; a antiga não repete", async () => {
    const sent: string[] = [];
    const send = vi.fn(async (sub: { endpoint: string }) => { sent.push(sub.endpoint); });
    const db = makeDb({ [DONO]: [device("d1")] });
    src.listExceptionCandidates.mockResolvedValue([exception("e1", DONO)]);
    await runPushSweep(db, createPushCursor(now), now, { send });
    src.listExceptionCandidates.mockResolvedValue([exception("e1", DONO), exception("e2", DONO)]);
    await runPushSweep(db, createPushCursor(now), new Date(now.getTime() + 60_000), { send });
    expect(sent).toHaveLength(2);
  });

  it("retenção: a limpeza apaga só as chaves com mais de 7 dias", async () => {
    await pg.query("insert into public.push_notification_log(dedupe_key,user_id,created_at) values ('exception:velha:11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','2026-11-01T00:00:00Z'), ('exception:nova:11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','2026-11-19T14:00:00Z')");
    await runPushSweep(makeDb({}), createPushCursor(now), now); // a varredura dispara a limpeza (cursor sem lastPurgeAt)
    const keys = (await pg.query<{ dedupe_key: string }>("select dedupe_key from public.push_notification_log order by 1")).rows.map((r) => r.dedupe_key);
    expect(keys).toEqual([`exception:nova:${DONO}`]);
  });
});

describe("o provedor aceita o push, mas a resposta se perde", () => {
  it("timeout DEPOIS de o provedor aceitar: não repete (o aparelho recebe exatamente 1 aviso)", async () => {
    const delivered: string[] = [];
    const send = vi.fn(async (sub: { endpoint: string }) => { delivered.push(sub.endpoint); throw new Error("socket hang up"); }); // aceitou e a resposta se perdeu (sem statusCode)
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb({ [DONO]: [device("d1")] });
    src.listExceptionCandidates.mockResolvedValue([exception("e1", DONO)]);
    for (let i = 0; i < 4; i++) await runPushSweep(db, createPushCursor(now), new Date(now.getTime() + i * 30_000), { send });
    log.mockRestore();
    expect(delivered).toEqual(["https://push.example/d1"]); // uma única tentativa, nunca duplicada
    expect((await pg.query("select dedupe_key from public.push_notification_log")).rows).toEqual([{ dedupe_key: `exception:e1:${DONO}` }]); // a chave continua reservada
  });

  it("dois aparelhos: um aceitou, no outro a resposta se perdeu: ninguém recebe duplicado nas varreduras seguintes", async () => {
    const delivered: string[] = [];
    const send = vi.fn(async (sub: { endpoint: string }) => { delivered.push(sub.endpoint); if (sub.endpoint.endsWith("/d2")) throw new Error("ETIMEDOUT"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb({ [DONO]: [device("d1"), device("d2")] });
    src.listExceptionCandidates.mockResolvedValue([exception("e1", DONO)]);
    for (let i = 0; i < 3; i++) await runPushSweep(db, createPushCursor(now), new Date(now.getTime() + i * 30_000), { send });
    log.mockRestore();
    expect(delivered.sort()).toEqual(["https://push.example/d1", "https://push.example/d2"]); // 1 tentativa por aparelho, total
  });

  it("falha ANTES de enviar (leitura das assinaturas): libera a chave, tenta de novo e entrega uma única vez", async () => {
    const delivered: string[] = [];
    const send = vi.fn(async (sub: { endpoint: string }) => { delivered.push(sub.endpoint); });
    let reads = 0;
    const db = makeDb({ [DONO]: [device("d1")] }, { failSubscriptionRead: () => reads++ === 0 }); // só a 1ª leitura falha
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    src.listExceptionCandidates.mockResolvedValue([exception("e1", DONO)]);
    for (let i = 0; i < 3; i++) await runPushSweep(db, createPushCursor(now), new Date(now.getTime() + i * 30_000), { send });
    log.mockRestore();
    expect(delivered).toEqual(["https://push.example/d1"]);
  });
});
