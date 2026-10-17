import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
import { unsubscribeThisDevice } from "./push-client";

const order: string[] = [];
const reg = (sub: any) => async () => ({ pushManager: { getSubscription: async () => sub } });

describe("unsubscribeThisDevice", () => {
  it("avisa o servidor primeiro e só depois cancela no navegador", async () => {
    order.length = 0;
    const sub = { endpoint: "e", unsubscribe: vi.fn(async () => { order.push("browser"); return true; }) };
    await unsubscribeThisDevice(reg(sub), async () => { order.push("server"); });
    expect(order).toEqual(["server", "browser"]);
  });
  it("se o servidor falha ainda cancela no navegador e não lança", async () => {
    const sub = { endpoint: "e", unsubscribe: vi.fn(async () => true) };
    await expect(unsubscribeThisDevice(reg(sub), async () => { throw new Error("offline"); })).resolves.toBeUndefined();
    expect(sub.unsubscribe).toHaveBeenCalled();
  });
  it("sem assinatura ou sem registro não faz nada", async () => {
    const post = vi.fn();
    await unsubscribeThisDevice(reg(null), post);
    await unsubscribeThisDevice(async () => undefined, post);
    await unsubscribeThisDevice(async () => { throw new Error("x"); }, post);
    expect(post).not.toHaveBeenCalled();
  });
});
