import { describe, it, expect, vi } from "vitest";
import { buildLidPhoneMap, applyLidMap, createLidPhoneResolver } from "./lid-phone-map.js";

const LID = "85801266339926@lid";
const LID2 = "11111111111111@lid";
const ALT = "556296818769@s.whatsapp.net";
const ALT2 = "5511999990000@s.whatsapp.net";
const rec = (remoteJid: string, remoteJidAlt?: string | null) => ({
  key: { remoteJid, ...(remoteJidAlt !== undefined ? { remoteJidAlt } : {}), fromMe: false, id: "x" },
});

describe("buildLidPhoneMap / applyLidMap", () => {
  it("usa o alt de qualquer registro do mesmo lid; lids diferentes não se misturam", () => {
    const map = buildLidPhoneMap([rec(LID), rec(LID, ALT), rec(LID2, ALT2), rec("5511@s.whatsapp.net", ALT2)]);
    expect(map.get(LID)).toBe("556296818769");
    expect(map.get(LID2)).toBe("5511999990000");
    expect(map.size).toBe(2);
  });

  it("mesmo lid com dois telefones distintos não é mapeado e gera aviso", () => {
    const warn = vi.fn();
    const map = buildLidPhoneMap([rec(LID, ALT), rec(LID, ALT2), rec(LID, ALT), rec(LID2, ALT2)], { warn });
    expect(map.has(LID)).toBe(false);
    expect(map.get(LID2)).toBe("5511999990000");
    expect(warn).toHaveBeenCalled();
  });

  it("alt igual ao número da instância é descartado", () => {
    const map = buildLidPhoneMap([rec(LID, ALT)], { ownPhones: new Set(["556296818769"]) });
    expect(map.size).toBe(0);
  });

  it("alt 0@s.whatsapp.net não entra no mapa", () => {
    expect(buildLidPhoneMap([rec(LID, "0@s.whatsapp.net")]).size).toBe(0);
  });

  it("alt inválido não entra no mapa", () => {
    expect(buildLidPhoneMap([rec(LID, "123@lid"), rec(LID, null), rec(LID, "@s.whatsapp.net")]).size).toBe(0);
  });

  it("applyLidMap injeta alt sintético só em @lid sem alt válido", () => {
    const map = buildLidPhoneMap([rec(LID, ALT)]);
    expect(applyLidMap(rec(LID), map).key.remoteJidAlt).toBe(ALT);
    expect(applyLidMap(rec(LID2), map).key.remoteJidAlt).toBeUndefined();
    const own = rec(LID, ALT2);
    expect(applyLidMap(own, map)).toBe(own);
    const normal = rec("5511@s.whatsapp.net");
    expect(applyLidMap(normal, map)).toBe(normal);
  });
});

describe("createLidPhoneResolver", () => {
  const make = (over: Partial<Parameters<typeof createLidPhoneResolver>[0]> = {}) => {
    let t = 1_000_000;
    const fetchRecords = vi.fn(async (_i: string, _lid: string, _signal?: AbortSignal) => [rec(LID, ALT)] as any[]);
    const warn = vi.fn();
    const r = createLidPhoneResolver({ fetchRecords, now: () => t, warn, ...over });
    return { r, fetchRecords, warn, advance: (ms: number) => { t += ms; } };
  };

  it("mensagem com alt devolve o número e alimenta o cache (sem consultar o Evolution)", async () => {
    const { r, fetchRecords } = make();
    expect(await r.resolve({ remoteJid: LID, remoteJidAlt: ALT }, "inst")).toBe("556296818769");
    expect(await r.resolve({ remoteJid: LID }, "inst")).toBe("556296818769");
    expect(fetchRecords).not.toHaveBeenCalled();
  });

  it("remoteJid normal não consulta nada", async () => {
    const { r, fetchRecords } = make();
    expect(await r.resolve({ remoteJid: "5511@s.whatsapp.net" }, "inst")).toBe("5511");
    expect(fetchRecords).not.toHaveBeenCalled();
  });

  it("miss consulta o Evolution uma vez e depois é cache hit", async () => {
    const { r, fetchRecords } = make();
    expect(await r.resolve({ remoteJid: LID }, "inst")).toBe("556296818769");
    expect(await r.resolve({ remoteJid: LID }, "inst")).toBe("556296818769");
    expect(fetchRecords).toHaveBeenCalledTimes(1);
    expect(fetchRecords).toHaveBeenCalledWith("inst", LID, expect.any(AbortSignal));
  });

  it("entrada expira após o TTL e é consultada de novo", async () => {
    const { r, fetchRecords, advance } = make({ ttlMs: 1000 });
    await r.resolve({ remoteJid: LID }, "inst");
    advance(1001);
    await r.resolve({ remoteJid: LID }, "inst");
    expect(fetchRecords).toHaveBeenCalledTimes(2);
  });

  it("respeita o teto de tamanho (descarta a mais antiga)", async () => {
    const { r } = make({ maxSize: 2 });
    r.remember({ remoteJid: "1@lid", remoteJidAlt: "55111111111@s.whatsapp.net" }, "inst");
    r.remember({ remoteJid: "2@lid", remoteJidAlt: "55122222222@s.whatsapp.net" }, "inst");
    r.remember({ remoteJid: "3@lid", remoteJidAlt: "55133333333@s.whatsapp.net" }, "inst");
    expect(r.size()).toBe(2);
    expect(r.get("inst", "1@lid")).toBeUndefined();
    expect(r.get("inst", "3@lid")).toBe("55133333333");
  });

  it("Evolution sem nenhum alt: devolve o remoteJid (nunca inventa) e não repete a consulta de imediato", async () => {
    const fetchRecords = vi.fn(async () => [rec(LID)] as any[]);
    const { r } = make({ fetchRecords });
    expect(await r.resolve({ remoteJid: LID }, "inst")).toBe(LID);
    expect(await r.resolve({ remoteJid: LID }, "inst")).toBe(LID);
    expect(fetchRecords).toHaveBeenCalledTimes(1);
  });

  it("erro do Evolution: avisa e devolve o remoteJid", async () => {
    const { r, warn } = make({ fetchRecords: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await r.resolve({ remoteJid: LID }, "inst")).toBe(LID);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("timeout do Evolution: devolve o remoteJid sem esperar a consulta", async () => {
    const { r, warn } = make({ timeoutMs: 20, fetchRecords: vi.fn(() => new Promise<any[]>(() => {})) });
    const t0 = Date.now();
    expect(await r.resolve({ remoteJid: LID }, "inst")).toBe(LID);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("após falha, nova tentativa só depois do TTL negativo", async () => {
    const fetchRecords = vi.fn(async () => { throw new Error("boom"); });
    const { r, advance } = make({ fetchRecords, negativeTtlMs: 60_000 });
    await r.resolve({ remoteJid: LID }, "inst");
    await r.resolve({ remoteJid: LID }, "inst");
    expect(fetchRecords).toHaveBeenCalledTimes(1);
    advance(60_001);
    await r.resolve({ remoteJid: LID }, "inst");
    expect(fetchRecords).toHaveBeenCalledTimes(2);
  });

  it("M1: consultas simultâneas do mesmo lid viram uma só", async () => {
    let release!: (v: any[]) => void;
    const fetchRecords = vi.fn(() => new Promise<any[]>((res) => { release = res; }));
    const { r } = make({ fetchRecords });
    const calls = [1, 2, 3].map(() => r.resolve({ remoteJid: LID }, "inst"));
    await Promise.resolve();
    release([rec(LID, ALT)]);
    expect(await Promise.all(calls)).toEqual(["556296818769", "556296818769", "556296818769"]);
    expect(fetchRecords).toHaveBeenCalledTimes(1);
  });

  it("M1: o signal repassado ao fetch aborta no timeout", async () => {
    let seen: AbortSignal | undefined;
    const fetchRecords = vi.fn((_i: string, _l: string, signal?: AbortSignal) => { seen = signal; return new Promise<any[]>(() => {}); });
    const { r } = make({ fetchRecords, timeoutMs: 20 });
    await r.resolve({ remoteJid: LID }, "inst");
    expect(seen?.aborted).toBe(true);
  });

  it("M2: mensagem com alt chegando durante o lookup vence o timeout/falha", async () => {
    let fail!: (e: Error) => void;
    const fetchRecords = vi.fn(() => new Promise<any[]>((_, rej) => { fail = rej; }));
    const { r } = make({ fetchRecords });
    const first = r.resolve({ remoteJid: LID }, "inst");
    await Promise.resolve();
    await r.resolve({ remoteJid: LID, remoteJidAlt: ALT }, "inst");
    fail(new Error("boom"));
    expect(await first).toBe("556296818769");
  });

  it("B1: remember com telefone diferente remove do cache, avisa e deixa de mapear", async () => {
    const { r, warn, fetchRecords } = make();
    r.remember({ remoteJid: LID, remoteJidAlt: ALT }, "inst");
    r.remember({ remoteJid: LID, remoteJidAlt: ALT2 }, "inst");
    expect(r.get("inst", LID)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(await r.resolve({ remoteJid: LID }, "inst")).toBe(LID);
    expect(fetchRecords).not.toHaveBeenCalled();
  });

  it("B1: alt igual ao número da instância é ignorado e nunca mapeado", async () => {
    const fetchRecords = vi.fn(async () => [] as any[]);
    const { r } = make({ fetchRecords });
    expect(await r.resolve({ remoteJid: LID, remoteJidAlt: ALT }, "inst", "+55 62 9681-8769")).toBe(LID);
    expect(r.get("inst", LID)).toBeUndefined();
    expect(fetchRecords).toHaveBeenCalledTimes(1);
  });

  it("B2: alt 0@s.whatsapp.net não é mapeado", async () => {
    const { r } = make({ fetchRecords: vi.fn(async () => [] as any[]) });
    expect(await r.resolve({ remoteJid: LID, remoteJidAlt: "0@s.whatsapp.net" }, "inst")).toBe(LID);
    expect(r.get("inst", LID)).toBeUndefined();
  });

  it("B3: cache (e negativa) são por instância", async () => {
    const { r, fetchRecords } = make();
    await r.resolve({ remoteJid: LID }, "inst-a");
    await r.resolve({ remoteJid: LID }, "inst-b");
    expect(fetchRecords).toHaveBeenCalledTimes(2);
    expect(r.get("inst-a", LID)).toBe("556296818769");
  });

  it("B4: reset limpa cache e negativa", async () => {
    const { r, fetchRecords } = make();
    await r.resolve({ remoteJid: LID }, "inst");
    r.reset();
    await r.resolve({ remoteJid: LID }, "inst");
    expect(fetchRecords).toHaveBeenCalledTimes(2);
  });
});
