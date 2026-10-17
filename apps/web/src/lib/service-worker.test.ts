import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function loadSw() {
  const listeners: Record<string, (e: any) => void> = {};
  const shown: any[] = [];
  const self: any = {
    location: { origin: "https://crm.example" },
    addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    registration: { showNotification: vi.fn(async (...a: unknown[]) => { shown.push(a); }) },
    clients: { claim: vi.fn(), matchAll: vi.fn(), openWindow: vi.fn() },
    skipWaiting: vi.fn(),
  };
  runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), { self, URL, Promise });
  return { self, listeners, shown };
}
const waitable = (extra: object) => { const p: Promise<unknown>[] = []; return { e: { waitUntil: (x: Promise<unknown>) => p.push(x), ...extra }, done: () => Promise.all(p) }; };

describe("sw.js", () => {
  it("push mostra a notificação com title, body, tag e url", async () => {
    const { listeners, shown } = loadSw();
    const w = waitable({ data: { json: () => ({ title: "Novo lead: Ana", body: "b", url: "/inbox?id=1", tag: "t" }) } });
    listeners.push(w.e); await w.done();
    expect(shown[0][0]).toBe("Novo lead: Ana");
    expect(shown[0][1]).toMatchObject({ body: "b", tag: "t", data: { url: "/inbox?id=1" } });
  });
  it("push com payload inválido ainda mostra algo", async () => {
    const { listeners, shown } = loadSw();
    const w = waitable({ data: { json: () => { throw new Error("x"); } } });
    listeners.push(w.e); await w.done();
    expect(shown[0][0]).toBe("Moto e Trilha");
  });
  it("clique foca a janela existente e navega para a url", async () => {
    const { self, listeners } = loadSw();
    const client: any = { url: "https://crm.example/inbox", focus: vi.fn(async () => client), navigate: vi.fn() };
    self.clients.matchAll.mockResolvedValue([client]);
    const close = vi.fn();
    const w = waitable({ notification: { close, data: { url: "/inbox?id=9" } } });
    listeners.notificationclick(w.e); await w.done();
    expect(close).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith("https://crm.example/inbox?id=9");
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });
  it("se navigate falhar (janela não controlada) abre uma nova janela", async () => {
    const { self, listeners } = loadSw();
    const client: any = { url: "https://crm.example/inbox", focus: vi.fn(async () => client), navigate: vi.fn(async () => { throw new Error("uncontrolled"); }) };
    self.clients.matchAll.mockResolvedValue([client]);
    const w = waitable({ notification: { close: vi.fn(), data: { url: "/inbox?id=9" } } });
    listeners.notificationclick(w.e); await w.done();
    expect(self.clients.openWindow).toHaveBeenCalledWith("https://crm.example/inbox?id=9");
  });
  it("clique sem janela aberta abre uma nova", async () => {
    const { self, listeners } = loadSw();
    self.clients.matchAll.mockResolvedValue([]);
    const w = waitable({ notification: { close: vi.fn(), data: { url: "/inbox?id=9" } } });
    listeners.notificationclick(w.e); await w.done();
    expect(self.clients.openWindow).toHaveBeenCalledWith("https://crm.example/inbox?id=9");
  });
});
