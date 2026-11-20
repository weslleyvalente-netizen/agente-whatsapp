import { describe, expect, it } from "vitest";
import { describeUazapiPanel } from "./uazapi-panel-state";

describe("describeUazapiPanel", () => {
  it("ainda não criada: pode conectar, não pode virar", () => {
    expect(describeUazapiPanel({ provider: "evolution", status: "not_created", connected: false }))
      .toEqual({ label: "Ainda não conectada", canConnect: true, canSwitchToUazapi: false, canSwitchToEvolution: false, polling: false });
  });
  it("conectando: aguarda QR e consulta de 5 em 5 s", () => {
    expect(describeUazapiPanel({ provider: "evolution", status: "connecting", connected: false }))
      .toMatchObject({ label: "Aguardando leitura do QR Code", canConnect: true, canSwitchToUazapi: false, polling: true });
  });
  it("conectada e em uso a Evolution: pode virar para UAZAPI", () => {
    expect(describeUazapiPanel({ provider: "evolution", status: "connected", connected: true }))
      .toEqual({ label: "Conectada", canConnect: false, canSwitchToUazapi: true, canSwitchToEvolution: false, polling: false });
  });
  it("conectada e em uso a UAZAPI: pode voltar para a Evolution", () => {
    expect(describeUazapiPanel({ provider: "uazapi", status: "connected", connected: true }))
      .toMatchObject({ canSwitchToUazapi: false, canSwitchToEvolution: true });
  });
  it("desconectada em uso pela UAZAPI: volta disponível, virada não", () => {
    expect(describeUazapiPanel({ provider: "uazapi", status: "disconnected", connected: false }))
      .toEqual({ label: "Desconectada", canConnect: true, canSwitchToUazapi: false, canSwitchToEvolution: true, polling: false });
  });
  it("UAZAPI indisponível em uso: mostra o estado e mantém a volta para a Evolution", () => {
    expect(describeUazapiPanel({ provider: "uazapi", status: "unavailable", connected: false }))
      .toEqual({ label: "UAZAPI indisponível", canConnect: true, canSwitchToUazapi: false, canSwitchToEvolution: true, polling: false });
  });
});
