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
    const fetchRecords = vi.fn(async (_i: string, _lid: string) => [rec(LID, ALT)] as any[]);
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
    expect(fetchRecords).toHaveBeenCalledWith("inst", LID);
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
    r.remember({ remoteJid: "1@lid", remoteJidAlt: "551@s.whatsapp.net" });
    r.remember({ remoteJid: "2@lid", remoteJidAlt: "552@s.whatsapp.net" });
    r.remember({ remoteJid: "3@lid", remoteJidAlt: "553@s.whatsapp.net" });
    expect(r.size()).toBe(2);
    expect(r.get("1@lid")).toBeUndefined();
    expect(r.get("3@lid")).toBe("553");
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
});
