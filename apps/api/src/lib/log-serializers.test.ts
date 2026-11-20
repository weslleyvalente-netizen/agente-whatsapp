import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { redactUrlSecrets, requestLogSerializer } from "./log-serializers.js";

describe("log de requisição sem segredo na URL", () => {
  it("redige apikey e key da query", () => {
    expect(redactUrlSecrets("/webhooks/uazapi?apikey=SEGREDO&x=1")).toBe("/webhooks/uazapi?apikey=[redacted]&x=1");
    expect(redactUrlSecrets("/w?key=abc")).toBe("/w?key=[redacted]");
    expect(redactUrlSecrets("/health")).toBe("/health");
  });

  it("o logger do Fastify com o serializador não escreve o segredo", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
    const app = Fastify({ logger: { level: "info", stream, serializers: { req: requestLogSerializer } } });
    app.post("/webhooks/uazapi", async () => ({ ok: true }));
    await app.inject({ method: "POST", url: "/webhooks/uazapi?apikey=SEGREDO", payload: {} });
    await app.close();
    const all = lines.join("");
    expect(all).toContain("/webhooks/uazapi?apikey=[redacted]");
    expect(all).not.toContain("SEGREDO");
  });
});
