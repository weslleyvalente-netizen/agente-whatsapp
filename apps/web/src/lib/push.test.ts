import { describe, expect, it } from "vitest";
import { getPushStatus, shouldShowPushBanner, urlBase64ToUint8Array, type PushEnv } from "./push";

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


describe("shouldShowPushBanner", () => {
  const base = { flagOn: true, status: "inactive" as const, pathname: "/inbox", dismissedUntil: null, now: 1_000 };
  it("aparece para quem ainda não ativou (desativado, precisa instalar ou bloqueado)", () => {
    expect(shouldShowPushBanner(base)).toBe(true);
    expect(shouldShowPushBanner({ ...base, status: "needs-install" })).toBe(true);
    expect(shouldShowPushBanner({ ...base, status: "denied" })).toBe(true);
  });
  it("não aparece quando já está ativo, sem suporte, indisponível no servidor ou ainda carregando", () => {
    for (const status of ["active", "unsupported", "unavailable", null] as const) expect(shouldShowPushBanner({ ...base, status })).toBe(false);
  });
  it("não aparece com o recurso desligado na organização nem na própria tela de notificações", () => {
    expect(shouldShowPushBanner({ ...base, flagOn: false })).toBe(false);
    expect(shouldShowPushBanner({ ...base, pathname: "/notificacoes" })).toBe(false);
  });
  it("respeita o 'agora não' por 24 h e volta depois", () => {
    expect(shouldShowPushBanner({ ...base, dismissedUntil: 5_000 })).toBe(false);
    expect(shouldShowPushBanner({ ...base, dismissedUntil: 5_000, now: 5_000 })).toBe(true);
  });
});
