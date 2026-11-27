import { describe, expect, it } from "vitest";
import { evaluateProviderHealth, resolveProviderMonitorMode, type ProviderHealthInput } from "./provider-health.js";

const now = new Date("2026-11-27T13:00:00Z"); // sexta 10h BRT
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const base = (over: Partial<ProviderHealthInput> = {}): ProviderHealthInput => ({
  now, processStartedAt: ago(120),
  provider: { ok: true, state: "connected", lastInboundAt: ago(2) },
  crmLastInboundAt: ago(2),
  oldestUnconfirmedOutboundAt: null,
  lastWebhookEventAt: ago(1),
  queue: { ok: true, waiting: 0, oldestWaitingAt: null },
  ...over,
});
const kind = (input: ProviderHealthInput, k: string) => evaluateProviderHealth(input).find((c) => c.kind === k)!;

describe("evaluateProviderHealth", () => {
  it("tudo saudável: nenhuma condição com problema", () => {
    expect(evaluateProviderHealth(base()).filter((c) => c.status === "problem")).toEqual([]);
  });

  describe("provider_disconnected", () => {
    it("UAZAPI fora de 'connected' é problema", () => {
      expect(kind(base({ provider: { ok: true, state: "disconnected", lastInboundAt: null } }), "provider_disconnected").status).toBe("problem");
      expect(kind(base({ provider: { ok: true, state: "connecting", lastInboundAt: null } }), "provider_disconnected").status).toBe("problem");
    });
    it("consulta à UAZAPI falhou: desconhecido (não afirma nada)", () => {
      expect(kind(base({ provider: { ok: false, state: null, lastInboundAt: null } }), "provider_disconnected").status).toBe("unknown");
    });
  });

  describe("provider_ahead (a UAZAPI recebeu e o CRM não: webhook não entregou)", () => {
    it("cliente escreveu há 10 min na UAZAPI e o CRM parou há 40 min: problema, com o atraso na evidência", () => {
      const c = kind(base({ provider: { ok: true, state: "connected", lastInboundAt: ago(10) }, crmLastInboundAt: ago(40) }), "provider_ahead");
      expect(c.status).toBe("problem");
      expect(c.evidence.lag_minutes).toBe(30);
    });
    it("mensagem acabou de chegar na UAZAPI (menos de 3 min): ainda dá tempo do webhook entregar, ok", () => {
      expect(kind(base({ provider: { ok: true, state: "connected", lastInboundAt: ago(1) }, crmLastInboundAt: ago(40) }), "provider_ahead").status).toBe("ok");
    });
    it("diferença pequena (tolerância de 3 min) é ok", () => {
      expect(kind(base({ provider: { ok: true, state: "connected", lastInboundAt: ago(10) }, crmLastInboundAt: ago(12) }), "provider_ahead").status).toBe("ok");
    });
    it("CRM sem nenhuma mensagem e UAZAPI com mensagem antiga: problema", () => {
      expect(kind(base({ provider: { ok: true, state: "connected", lastInboundAt: ago(10) }, crmLastInboundAt: null }), "provider_ahead").status).toBe("problem");
    });
    it("sem dado da UAZAPI: desconhecido", () => {
      expect(kind(base({ provider: { ok: false, state: null, lastInboundAt: null } }), "provider_ahead").status).toBe("unknown");
      expect(kind(base({ provider: { ok: true, state: "connected", lastInboundAt: null } }), "provider_ahead").status).toBe("ok");
    });
  });

  describe("webhook_stalled (enviamos e nenhuma confirmação/evento voltou)", () => {
    it("mensagem enviada há 12 min sem nenhum evento do webhook desde então: problema (funciona mesmo com pouco movimento)", () => {
      const c = kind(base({ oldestUnconfirmedOutboundAt: ago(12), lastWebhookEventAt: ago(30) }), "webhook_stalled");
      expect(c.status).toBe("problem");
      expect(c.evidence.minutes_since_last_event).toBe(30);
    });
    it("houve evento do webhook depois do envio: ok", () => {
      expect(kind(base({ oldestUnconfirmedOutboundAt: ago(12), lastWebhookEventAt: ago(5) }), "webhook_stalled").status).toBe("ok");
    });
    it("envio recente (menos de 5 min): ok, ainda pode chegar a confirmação", () => {
      expect(kind(base({ oldestUnconfirmedOutboundAt: ago(3), lastWebhookEventAt: ago(30) }), "webhook_stalled").status).toBe("ok");
    });
    it("API reiniciou há pouco (pulso em memória ainda vazio): desconhecido, não acusa falso problema", () => {
      expect(kind(base({ processStartedAt: ago(4), oldestUnconfirmedOutboundAt: ago(12), lastWebhookEventAt: null }), "webhook_stalled").status).toBe("unknown");
    });
    it("API no ar há tempo, enviamos e nunca chegou evento: problema", () => {
      expect(kind(base({ oldestUnconfirmedOutboundAt: ago(12), lastWebhookEventAt: null }), "webhook_stalled").status).toBe("problem");
    });
    it("nada enviado no período: ok", () => {
      expect(kind(base({ oldestUnconfirmedOutboundAt: null, lastWebhookEventAt: null }), "webhook_stalled").status).toBe("ok");
    });
  });

  describe("queue_backlog (fila de processamento represada)", () => {
    it("job esperando há mais de 5 min: problema", () => {
      const c = kind(base({ queue: { ok: true, waiting: 7, oldestWaitingAt: ago(9) } }), "queue_backlog");
      expect(c.status).toBe("problem");
      expect(c.evidence).toMatchObject({ waiting: 7, oldest_waiting_minutes: 9 });
    });
    it("fila andando (job recente): ok", () => {
      expect(kind(base({ queue: { ok: true, waiting: 3, oldestWaitingAt: ago(1) } }), "queue_backlog").status).toBe("ok");
    });
    it("Redis inacessível: desconhecido", () => {
      expect(kind(base({ queue: { ok: false, waiting: null, oldestWaitingAt: null } }), "queue_backlog").status).toBe("unknown");
    });
  });
});

describe("resolveProviderMonitorMode", () => {
  it("só off/shadow/on; ausente ou inválido = off", () => {
    expect(resolveProviderMonitorMode({ provider_health_monitor_mode: "shadow" })).toBe("shadow");
    expect(resolveProviderMonitorMode({ provider_health_monitor_mode: "on" })).toBe("on");
    expect(resolveProviderMonitorMode({ provider_health_monitor_mode: true })).toBe("off");
    expect(resolveProviderMonitorMode({})).toBe("off");
    expect(resolveProviderMonitorMode(null)).toBe("off");
  });
});
