import { describe, expect, it } from "vitest";
import { getPushStatus, urlBase64ToUint8Array, type PushEnv } from "./push";

const base: PushEnv = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, isIos: false, standalone: false, permission: "default", subscribed: false };

describe("getPushStatus", () => {
  it("iOS fora do modo standalone pede para instalar o app", () => {
    expect(getPushStatus({ ...base, isIos: true, standalone: false, hasPushManager: false })).toBe("needs-install");
    expect(getPushStatus({ ...base, isIos: true, standalone: true })).toBe("inactive");
  });
  it("sem suporte do navegador", () => {
    expect(getPushStatus({ ...base, hasPushManager: false })).toBe("unsupported");
    expect(getPushStatus({ ...base, hasServiceWorker: false })).toBe("unsupported");
  });
  it("permissão negada", () => expect(getPushStatus({ ...base, permission: "denied" })).toBe("denied"));
  it("servidor sem chaves", () => expect(getPushStatus({ ...base, serverUnavailable: true })).toBe("unavailable"));
  it("ativo só com permissão concedida e assinatura", () => {
    expect(getPushStatus({ ...base, permission: "granted", subscribed: true })).toBe("active");
    expect(getPushStatus({ ...base, permission: "granted", subscribed: false })).toBe("inactive");
    expect(getPushStatus({ ...base, permission: "default", subscribed: true })).toBe("inactive");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodifica base64url", () => {
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
  });
});
