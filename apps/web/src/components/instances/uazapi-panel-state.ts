// Estado do painel "WhatsApp pela UAZAPI" a partir de GET /instances/:id/uazapi/status.
export type UazapiPanelInput = { provider: string; status: string; connected: boolean };
export type UazapiPanelState = { label: string; canConnect: boolean; canSwitchToUazapi: boolean; canSwitchToEvolution: boolean; polling: boolean };

const LABELS: Record<string, string> = { not_created: "Ainda não conectada", connecting: "Aguardando leitura do QR Code", connected: "Conectada", unavailable: "UAZAPI indisponível" };

export function describeUazapiPanel(s: UazapiPanelInput): UazapiPanelState {
  const connected = s.connected && s.status === "connected";
  return {
    label: LABELS[s.status] ?? "Desconectada",
    canConnect: !connected,
    canSwitchToUazapi: connected && s.provider === "evolution",
    canSwitchToEvolution: s.provider === "uazapi",
    polling: s.status === "connecting",
  };
}
