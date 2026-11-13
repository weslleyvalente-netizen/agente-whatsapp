import { describe, expect, it } from "vitest";
import { recordAdTouch } from "./lead-ad-touch.service.js";

const ORG = "o1", CONTACT = "c1";
const ad = { title: "Seu próximo carro", body: "Consórcio", sourceId: "999", sourceUrl: "https://www.instagram.com/p/AAA/", sourceType: "ad", ctwaClid: "clid", thumbnail: "BIN" };
const when = new Date("2026-11-13T15:00:00.000Z");

function fakeDb(opts: { recent?: Array<{ touch_key: string; ctwa_clid?: string | null; touched_at: string }>; insertError?: { code?: string; message?: string } | null; selectError?: unknown } = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const chain: Record<string, unknown> = {};
  for (const op of ["select", "eq", "order"]) chain[op] = (...args: unknown[]) => { calls.push({ op, args }); return chain; };
  const thenable = (value: unknown) => ({ abortSignal: (s: AbortSignal) => { calls.push({ op: "abortSignal", args: [s] }); return Promise.resolve(value); }, then: (res: (v: unknown) => unknown) => res(value) });
  chain.limit = (...args: unknown[]) => { calls.push({ op: "limit", args }); return thenable({ data: opts.recent ?? [], error: opts.selectError ?? null }); };
  const table = { ...chain, insert: (row: Record<string, unknown>) => { inserted.push(row); return thenable({ error: opts.insertError ?? null }); } };
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

  it("mesmo anúncio e mesmo clique já registrado: não grava de novo", async () => {
    const f = fakeDb({ recent: [{ touch_key: "id:999", ctwa_clid: "clid", touched_at: "2026-11-13T14:00:00Z" }] });
    expect(await recordAdTouch(f.db, base)).toBe("duplicate");
    expect(f.inserted).toHaveLength(0);
  });

  it("MESMO anúncio com outro clique (novo atendimento depois): grava um novo toque", async () => {
    const f = fakeDb({ recent: [{ touch_key: "id:999", ctwa_clid: "clid-antigo", touched_at: "2026-11-01T14:00:00Z" }] });
    expect(await recordAdTouch(f.db, base)).toBe("recorded");
    expect(f.inserted[0]).toMatchObject({ ad_id: "999", ctwa_clid: "clid" });
  });

  it("mesmo anúncio sem clique para comparar: dentro de 24 h é a mesma sessão; depois disso é novo atendimento", async () => {
    const noClid = { ...ad, ctwaClid: undefined };
    const same = fakeDb({ recent: [{ touch_key: "id:999", ctwa_clid: null, touched_at: "2026-11-13T05:00:00Z" }] });
    expect(await recordAdTouch(same.db, { ...base, ad: noClid })).toBe("duplicate");
    const later = fakeDb({ recent: [{ touch_key: "id:999", ctwa_clid: null, touched_at: "2026-11-10T05:00:00Z" }] });
    expect(await recordAdTouch(later.db, { ...base, ad: noClid })).toBe("recorded");
  });

  it("mensagem recuperada FORA DE ORDEM: clique nunca visto com horário anterior ao último toque do anúncio é gravado com o horário original", async () => {
    const f = fakeDb({ recent: [{ touch_key: "id:999", ctwa_clid: "clid-novo", touched_at: "2026-11-13T10:00:00Z" }] });
    const older = new Date("2026-11-01T10:00:00.000Z");
    expect(await recordAdTouch(f.db, { ...base, ad: { ...ad, ctwaClid: "clid-antigo" }, touchedAt: older })).toBe("recorded");
    expect(f.inserted[0]).toMatchObject({ ctwa_clid: "clid-antigo", touched_at: "2026-11-01T10:00:00.000Z" });
  });

  it("recuperação fora de ordem do MESMO clique já gravado, ou sem clique para comparar, não duplica", async () => {
    const seen = fakeDb({ recent: [
      { touch_key: "id:999", ctwa_clid: "clid-novo", touched_at: "2026-11-13T10:00:00Z" },
      { touch_key: "id:999", ctwa_clid: "clid-antigo", touched_at: "2026-11-01T10:00:00Z" },
    ] });
    expect(await recordAdTouch(seen.db, { ...base, ad: { ...ad, ctwaClid: "clid-antigo" }, touchedAt: new Date("2026-11-01T10:00:00Z") })).toBe("duplicate");
    const noClid = fakeDb({ recent: [{ touch_key: "id:999", ctwa_clid: "clid-novo", touched_at: "2026-11-13T10:00:00Z" }] });
    expect(await recordAdTouch(noClid.db, { ...base, ad: { ...ad, ctwaClid: undefined }, touchedAt: new Date("2026-11-01T10:00:00Z") })).toBe("duplicate");
  });

  it("a mesma mensagem reenviada continua barrada pelo índice único", async () => {
    const f = fakeDb({ recent: [{ touch_key: "id:999", ctwa_clid: "clid-antigo", touched_at: "2026-11-01T14:00:00Z" }], insertError: { code: "23505" } });
    expect(await recordAdTouch(f.db, base)).toBe("duplicate");
  });

  it("anúncio diferente dos toques recentes: registra um novo toque (a primeira origem fica preservada)", async () => {
    const f = fakeDb({ recent: [{ touch_key: "id:111", ctwa_clid: "x", touched_at: "2026-11-13T14:00:00Z" }] });
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

  it("com sinal de cancelamento: ele é aplicado à consulta E à gravação (o limite de tempo cobre a operação completa)", async () => {
    const f = fakeDb();
    const controller = new AbortController();
    expect(await recordAdTouch(f.db, { ...base, signal: controller.signal })).toBe("recorded");
    const used = f.calls.filter((c) => c.op === "abortSignal");
    expect(used).toHaveLength(2);
    expect(used.every((c) => c.args[0] === controller.signal)).toBe(true);
  });

  it("sem sinal: nada muda no comportamento (nenhum abortSignal)", async () => {
    const f = fakeDb();
    await recordAdTouch(f.db, base);
    expect(f.calls.some((c) => c.op === "abortSignal")).toBe(false);
  });
});
