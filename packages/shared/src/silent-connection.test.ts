import { describe, expect, it } from "vitest";
import { decideAlertAction, evaluateSilentConnection, hourOfWeekBrt, type SilenceInput } from "./silent-connection.js";

const now = new Date("2026-11-17T17:00:00Z"); // terça 14h BRT
const base = (over: Partial<SilenceInput> = {}): SilenceInput => ({ now, evolutionState: "open", lastInboundAt: new Date(now.getTime() - 5 * 60_000), baselinePerHour: 40, ...over });
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe("evaluateSilentConnection", () => {
  it("o caso de 17/11: open, 40 msgs/h habituais, 3 h sem receber → mudo", () => {
    const e = evaluateSilentConnection(base({ lastInboundAt: ago(180) }));
    expect(e.status).toBe("silent"); expect(e.probabilityOfSilence!).toBeLessThan(1e-6); expect(e.silentMinutes).toBe(180);
  });
  it("silêncio normal de poucos minutos num horário movimentado → ok", () => expect(evaluateSilentConnection(base({ lastInboundAt: ago(4) })).status).toBe("ok"));
  it("volume médio (10/h): 20 min é normal, 30 min é suspeito (sem alerta), 45 min é mudo", () => {
    expect(evaluateSilentConnection(base({ baselinePerHour: 10, lastInboundAt: ago(20) })).status).toBe("ok");
    expect(evaluateSilentConnection(base({ baselinePerHour: 10, lastInboundAt: ago(30) })).status).toBe("suspect");
    expect(evaluateSilentConnection(base({ baselinePerHour: 10, lastInboundAt: ago(45) })).status).toBe("silent");
  });
  it("60 min sem receber com 40/h → mudo", () => expect(evaluateSilentConnection(base({ lastInboundAt: ago(60) })).status).toBe("silent"));
  it("volume habitual baixo (madrugada/domingo): nunca alerta, mesmo com horas de silêncio", () => {
    const e = evaluateSilentConnection(base({ lastInboundAt: ago(600), baselinePerHour: 1 })); expect(e.status).toBe("not_applicable");
  });
  it("sem histórico de volume ou sem mensagem conhecida: não aplicável (não inventa alerta)", () => {
    expect(evaluateSilentConnection(base({ baselinePerHour: null })).status).toBe("not_applicable");
    expect(evaluateSilentConnection(base({ lastInboundAt: null })).status).toBe("not_applicable");
  });
  it("Evolution fora de 'open' (close/connecting/null): não é conexão muda, é conexão caída (outro alerta)", () => {
    for (const s of ["close", "connecting", null]) expect(evaluateSilentConnection(base({ evolutionState: s, lastInboundAt: ago(300) })).status).toBe("not_applicable");
  });
  it("silêncio abaixo do mínimo configurado nunca alerta", () => expect(evaluateSilentConnection(base({ lastInboundAt: ago(10), baselinePerHour: 500 })).status).toBe("ok"));
  it("quanto maior o volume habitual, mais cedo detecta (500/h: 15 min já é anormal se o mínimo permitir)", () => {
    const t = { minSilentMinutes: 10, minExpectedPerHour: 6, suspectProbability: 0.02, silentProbability: 0.001 };
    expect(evaluateSilentConnection(base({ lastInboundAt: ago(15), baselinePerHour: 500 }), t).status).toBe("silent");
    expect(evaluateSilentConnection(base({ lastInboundAt: ago(15), baselinePerHour: 8 }), t).status).toBe("ok");
  });
});

describe("decideAlertAction (sem alertas repetidos)", () => {
  const silent = evaluateSilentConnection(base({ lastInboundAt: ago(180) }));
  const ok = evaluateSilentConnection(base());
  const na = evaluateSilentConnection(base({ evolutionState: "close", lastInboundAt: ago(180) }));
  it("abre uma vez", () => expect(decideAlertAction(null, silent, now)).toBe("open"));
  it("dentro de 60 min não repete; passou 60 min repete", () => {
    expect(decideAlertAction({ openedAt: ago(30), lastNotifiedAt: ago(30) }, silent, now)).toBe("none");
    expect(decideAlertAction({ openedAt: ago(130), lastNotifiedAt: ago(61) }, silent, now)).toBe("repeat");
  });
  it("resolve quando voltar ao normal; 'não aplicável' não resolve nem abre", () => {
    expect(decideAlertAction({ openedAt: ago(90), lastNotifiedAt: ago(90) }, ok, now)).toBe("resolve");
    expect(decideAlertAction({ openedAt: ago(90), lastNotifiedAt: ago(90) }, na, now)).toBe("none");
    expect(decideAlertAction(null, na, now)).toBe("none"); expect(decideAlertAction(null, ok, now)).toBe("none");
  });
  it("suspeita não notifica", () => {
    const suspect = { ...silent, status: "suspect" as const }; expect(decideAlertAction(null, suspect, now)).toBe("none");
  });
});

describe("hourOfWeekBrt", () => {
  it("terça 14h BRT = 2*24+14", () => expect(hourOfWeekBrt(now)).toBe(62));
  it("virada de dia em BRT: 01h UTC de quarta ainda é terça 22h BRT", () => expect(hourOfWeekBrt(new Date("2026-11-18T01:00:00Z"))).toBe(2 * 24 + 22));
});

import { evaluateMonitorHealth, resolveSilentAlertMode } from "./silent-connection.js";
describe("resolveSilentAlertMode", () => {
  it("só off/shadow/on; ausente ou inválido = off (inclusive o booleano antigo true)", () => {
    expect(resolveSilentAlertMode({ silent_connection_alert_mode: "on" })).toBe("on");
    expect(resolveSilentAlertMode({ silent_connection_alert_mode: "shadow" })).toBe("shadow");
    for (const v of [undefined, "off", "ON", true, 1, null, ""]) expect(resolveSilentAlertMode({ silent_connection_alert_mode: v })).toBe("off");
    expect(resolveSilentAlertMode(null)).toBe("off");
  });
});
describe("evaluateMonitorHealth (saúde do próprio monitor)", () => {
  const maxAgeMs = 15 * 60_000;
  const obs = (minAgo: number, queryOk = true) => ({ observedAt: new Date(now.getTime() - minAgo * 60_000), queryOk });
  it("observação recente e consulta ok: ok", () => expect(evaluateMonitorHealth({ now, observation: obs(3), maxAgeMs })).toEqual({ status: "ok" }));
  it("sem observação: cego", () => expect(evaluateMonitorHealth({ now, observation: null, maxAgeMs })).toMatchObject({ status: "blind", reason: "no_observation" }));
  it("observação velha: cego, com a idade", () => expect(evaluateMonitorHealth({ now, observation: obs(40), maxAgeMs })).toMatchObject({ status: "blind", reason: "stale_observation", ageMinutes: 40 }));
  it("consulta à Evolution falhando: cego (não é 'tudo bem' nem 'mudo')", () => expect(evaluateMonitorHealth({ now, observation: obs(2, false), maxAgeMs })).toMatchObject({ status: "blind", reason: "evolution_query_failed" }));
});
