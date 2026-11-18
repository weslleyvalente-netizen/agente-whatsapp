import { describe, it, expect } from "vitest";
import {
  evaluateMessageAge, resolveStaleGuardMinutes, resolveStaleGuardMode, STALE_GUARD_DEFAULT_MINUTES, STALE_GUARD_FUTURE_TOLERANCE_MS,
} from "./stale-message-guard.js";

const NOW = new Date("2026-11-18T19:00:00.000Z");
const sec = (minAgo: number) => Math.floor(NOW.getTime() / 1000) - minAgo * 60;

describe("resolveStaleGuardMode", () => {
  it("só shadow/on ligam; qualquer outra coisa é off", () => {
    expect(resolveStaleGuardMode({ stale_message_guard_mode: "on" })).toBe("on");
    expect(resolveStaleGuardMode({ stale_message_guard_mode: "shadow" })).toBe("shadow");
    for (const v of [undefined, null, "off", "ON", true, 1, "", "yes"]) expect(resolveStaleGuardMode({ stale_message_guard_mode: v })).toBe("off");
    expect(resolveStaleGuardMode(null)).toBe("off");
    expect(resolveStaleGuardMode(undefined)).toBe("off");
  });
});

describe("resolveStaleGuardMinutes", () => {
  it("padrão quando ausente ou inválido", () => {
    for (const v of [undefined, null, "30", NaN, Infinity, {}]) expect(resolveStaleGuardMinutes({ stale_message_guard_minutes: v })).toBe(STALE_GUARD_DEFAULT_MINUTES);
  });
  it("limita entre 5 e 1440 e arredonda (nunca desliga por engano)", () => {
    expect(resolveStaleGuardMinutes({ stale_message_guard_minutes: 0 })).toBe(5);
    expect(resolveStaleGuardMinutes({ stale_message_guard_minutes: -10 })).toBe(5);
    expect(resolveStaleGuardMinutes({ stale_message_guard_minutes: 99999 })).toBe(1440);
    expect(resolveStaleGuardMinutes({ stale_message_guard_minutes: 45.6 })).toBe(46);
  });
});

describe("evaluateMessageAge", () => {
  const ev = (ts: unknown, thr = 20) => evaluateMessageAge({ messageTimestamp: ts, now: NOW, thresholdMinutes: thr });
  it("sem timestamp utilizável: no_timestamp (o fluxo segue como hoje)", () => {
    for (const v of [undefined, null, 0, -5, NaN, Infinity, "1700000000", {}]) expect(ev(v)).toEqual({ status: "no_timestamp", ageMinutes: null, originalAtIso: null });
  });
  it("mensagem recente é fresh e a idade em minutos bate", () => {
    const r = ev(sec(3));
    expect(r.status).toBe("fresh");
    expect(r.ageMinutes).toBeCloseTo(3, 1);
    expect(r.originalAtIso).toBe(new Date(sec(3) * 1000).toISOString());
  });
  it("limite: exatamente no limite ainda é atual; acima é atrasada", () => {
    expect(ev(sec(20)).status).toBe("fresh");
    expect(ev(sec(21)).status).toBe("stale");
    expect(ev(sec(185)).status).toBe("stale"); // o caso real de 18/11: ~3 h
  });
  it("aceita milissegundos por segurança", () => {
    expect(ev(sec(60) * 1000).status).toBe("stale");
    expect(ev(sec(2) * 1000).status).toBe("fresh");
  });
  it("diferença de relógio: adiantamento pequeno vira idade 0; grande é inválido (não é atrasada)", () => {
    const small = ev(sec(0) + 120);
    expect(small.status).toBe("fresh");
    expect(small.ageMinutes).toBe(0);
    const big = ev(Math.floor(NOW.getTime() / 1000) + STALE_GUARD_FUTURE_TOLERANCE_MS / 1000 + 60);
    expect(big).toEqual({ status: "future_clock_skew", ageMinutes: null, originalAtIso: null });
  });
  it("mensagens fora de ordem são avaliadas cada uma pelo próprio timestamp", () => {
    const seq = [sec(1), sec(120), sec(2), sec(90)].map((t) => ev(t).status);
    expect(seq).toEqual(["fresh", "stale", "fresh", "stale"]);
  });
});
