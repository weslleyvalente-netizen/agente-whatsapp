import { describe, expect, it } from "vitest";
import { recordAdTouch } from "./lead-ad-touch.service.js";

const ORG = "o1", CONTACT = "c1";
const ad = { title: "Seu próximo carro", body: "Consórcio", sourceId: "999", sourceUrl: "https://www.instagram.com/p/AAA/", sourceType: "ad", ctwaClid: "clid", thumbnail: "BIN" };
const when = new Date("2026-11-13T15:00:00.000Z");

function fakeDb(opts: { latest?: { touch_key: string } | null; insertError?: { code?: string; message?: string } | null; selectError?: unknown } = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const chain: Record<string, unknown> = {};
  for (const op of ["select", "eq", "order", "limit"]) chain[op] = (...args: unknown[]) => { calls.push({ op, args }); return chain; };
  chain.maybeSingle = async () => ({ data: opts.latest ?? null, error: opts.selectError ?? null });
  const table = { ...chain, insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: opts.insertError ?? null }; } };
  return { db: { from: (t: string) => { calls.push({ op: "from", args: [t] }); return table; } } as never, calls, inserted };
}

describe("recordAdTouch", () => {
  const base = { organizationId: ORG, contactId: CONTACT, conversationId: "v1", evolutionMessageId: "wamid1", touchedAt: when, ad };

  it("primeiro toque: grava a linha estruturada, com campanha nula e sem o binário", async () => {
    const f = fakeDb();
    expect(await recordAdTouch(f.db, base)).toBe("recorded");
    expect(f.inserted).toHaveLength(1);
    expect(f.inserted[0]).toMatchObject({
      organization_id: ORG, contact_id: CONTACT, conversation_id: "v1", evolution_message_id: "wamid1", touched_at: "2026-11-13T15:00:00.000Z",
      platform: "instagram", source_type: "ad", ad_id: "999", ad_title: "Seu próximo carro", ad_body: "Consórcio", ad_url: "https://www.instagram.com/p/AAA/",
      ctwa_clid: "clid", campaign_id: null, campaign_name: null, touch_key: "id:999",
    });
    expect(f.inserted[0].available_fields).not.toContain("thumbnail");
    expect(JSON.stringify(f.inserted[0])).not.toContain("BIN");
  });

  it("mesmo anúncio do último toque: não grava de novo", async () => {
    const f = fakeDb({ latest: { touch_key: "id:999" } });
    expect(await recordAdTouch(f.db, base)).toBe("duplicate");
    expect(f.inserted).toHaveLength(0);
  });

  it("anúncio diferente do último toque: registra um novo toque (a primeira origem fica preservada)", async () => {
    const f = fakeDb({ latest: { touch_key: "id:111" } });
    expect(await recordAdTouch(f.db, base)).toBe("recorded");
    expect(f.inserted).toHaveLength(1);
  });

  it("consulta o último toque do contato, só da própria organização", async () => {
    const f = fakeDb();
    await recordAdTouch(f.db, base);
    expect(f.calls).toContainEqual({ op: "eq", args: ["organization_id", ORG] });
    expect(f.calls).toContainEqual({ op: "eq", args: ["contact_id", CONTACT] });
  });

  it("reenvio da mesma mensagem (índice único) conta como duplicado, sem erro", async () => {
    const f = fakeDb({ insertError: { code: "23505", message: "duplicate key" } });
    expect(await recordAdTouch(f.db, base)).toBe("duplicate");
  });

  it("sem contexto de anúncio: não consulta nem grava", async () => {
    const f = fakeDb();
    expect(await recordAdTouch(f.db, { ...base, ad: null })).toBe("skipped");
    expect(await recordAdTouch(f.db, { ...base, ad: {} })).toBe("skipped");
    expect(f.calls).toHaveLength(0);
    expect(f.inserted).toHaveLength(0);
  });

  it("campos ausentes não impedem o registro", async () => {
    const f = fakeDb();
    expect(await recordAdTouch(f.db, { ...base, ad: { title: "Só título" }, conversationId: null, evolutionMessageId: null })).toBe("recorded");
    expect(f.inserted[0]).toMatchObject({ ad_id: null, ad_url: null, ctwa_clid: null, conversation_id: null, evolution_message_id: null, touch_key: "txt:só título|" });
  });

  it("erro do banco (diferente de duplicidade) é propagado para o chamador registrar", async () => {
    await expect(recordAdTouch(fakeDb({ insertError: { code: "42501", message: "boom" } }).db, base)).rejects.toBeTruthy();
    await expect(recordAdTouch(fakeDb({ selectError: { message: "x" } }).db, base)).rejects.toBeTruthy();
  });

  it("horário inválido ou no futuro usa o horário atual (nunca grava data impossível)", async () => {
    const f = fakeDb();
    await recordAdTouch(f.db, { ...base, touchedAt: new Date("2999-01-01T00:00:00Z") });
    const at = Date.parse(f.inserted[0].touched_at as string);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    const g = fakeDb();
    await recordAdTouch(g.db, { ...base, touchedAt: new Date("invalid") });
    expect(Number.isFinite(Date.parse(g.inserted[0].touched_at as string))).toBe(true);
  });
});
