import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ conn: null as any }));
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => m.conn }));
import { probeRedis } from "./redis-probe.js";

function fakeConn(status: string, ping: () => Promise<string> = async () => "PONG") {
  const c: any = new EventEmitter();
  c.status = status;
  c.ping = vi.fn(ping);
  return c;
}

describe("probeRedis", () => {
  beforeEach(() => { m.conn = null; });

  it("conexão pronta e PONG: ok", async () => {
    m.conn = fakeConn("ready");
    expect(await probeRedis(200)).toBe(true);
  });

  it("conexão ainda abrindo (logo após o boot) mas que fica pronta dentro do prazo: ok, sem alarme falso", async () => {
    m.conn = fakeConn("connecting");
    setTimeout(() => { m.conn.status = "ready"; m.conn.emit("ready"); }, 30);
    expect(await probeRedis(500)).toBe(true);
    expect(m.conn.ping).toHaveBeenCalledTimes(1);
  });

  it("conexão que não fica pronta no prazo: fora do ar, e não chama ping (não enfileira comando offline)", async () => {
    m.conn = fakeConn("reconnecting");
    expect(await probeRedis(60)).toBe(false);
    expect(m.conn.ping).not.toHaveBeenCalled();
    expect(m.conn.listenerCount("ready")).toBe(0); // não deixa ouvinte pendurado
  });

  it("conexão encerrada (sem tentativa em curso) falha na hora", async () => {
    m.conn = fakeConn("end");
    const t = Date.now();
    expect(await probeRedis(1000)).toBe(false);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it("pronta mas lenta demais (ping não responde no prazo): lento = falha", async () => {
    m.conn = fakeConn("ready", () => new Promise(() => {}));
    expect(await probeRedis(80)).toBe(false);
  });

  it("ping que lança erro: falha sem estourar", async () => {
    m.conn = fakeConn("ready", async () => { throw new Error("boom"); });
    expect(await probeRedis(200)).toBe(false);
  });
});
