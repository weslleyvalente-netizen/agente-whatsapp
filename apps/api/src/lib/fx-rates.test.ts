import { describe, it, expect, beforeEach } from "vitest";
import { getUsdBrlRates, parsePtax, rateOnOrBefore, resetFxCacheForTests } from "./fx-rates.js";

const row = (d: string, v: number) => ({ cotacaoVenda: v, dataHoraCotacao: `${d} 13:11:00.0` });

describe("parsePtax", () => {
  it("lê a cotação de venda de cada dia (formato real do BCB)", () => {
    const m = parsePtax({ value: [row("2026-10-05", 4.9859), row("2026-10-06", 4.9698)] });
    expect([...m]).toEqual([["2026-10-05", 4.9859], ["2026-10-06", 4.9698]]);
  });
  it("ignora resposta vazia ou cotação inválida", () => {
    expect(parsePtax({}).size).toBe(0);
    expect(parsePtax({ value: [row("2026-10-05", 0)] }).size).toBe(0);
  });
});

describe("rateOnOrBefore", () => {
  const rates = new Map([["2026-10-02", 5.4], ["2026-10-05", 5.5]]);
  it("usa a do próprio dia", () => expect(rateOnOrBefore(rates, "2026-10-05")).toEqual({ rate: 5.5, rateDate: "2026-10-05" }));
  it("fim de semana usa a última anterior", () => expect(rateOnOrBefore(rates, "2026-10-04")).toEqual({ rate: 5.4, rateDate: "2026-10-02" }));
  it("sem cotação anterior devolve null", () => expect(rateOnOrBefore(rates, "2026-09-01")).toBeNull());
});

describe("getUsdBrlRates", () => {
  beforeEach(resetFxCacheForTests);
  const now = new Date("2026-10-08T15:00:00Z").getTime();
  it("busca o BCB, usa cache em dias passados e tolera falha de rede", async () => {
    let calls = 0;
    const ok = (async () => { calls++; return { ok: true, json: async () => ({ value: [row("2026-10-02", 5.4)] }) }; }) as any;
    const a = await getUsdBrlRates("2026-10-01", "2026-10-03", ok, now);
    expect(a.get("2026-10-02")).toBe(5.4);
    await getUsdBrlRates("2026-10-01", "2026-10-03", ok, now + 1);
    expect(calls).toBe(1);
    resetFxCacheForTests();
    const fail = (async () => { throw new Error("rede"); }) as any;
    expect((await getUsdBrlRates("2026-10-01", "2026-10-03", fail, now)).size).toBe(0);
  });
});
