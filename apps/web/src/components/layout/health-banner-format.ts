export interface HealthState {
  status: "ok" | "warning";
  reasons: string[];
  lastCustomerMessageAt: string | null;
}

/** "Possível falha: sem mensagens de clientes há X h" — ou o texto genérico se nunca houve mensagem. */
export function bannerTitle(health: HealthState, now: number = Date.now()): string {
  if (!health.lastCustomerMessageAt) return "Possível falha: nenhuma mensagem de cliente registrada";
  const ms = now - Date.parse(health.lastCustomerMessageAt);
  if (!Number.isFinite(ms) || ms < 0) return "Possível falha no recebimento de mensagens";
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1
    ? `Possível falha: sem mensagens de clientes há ${hours} h`
    : `Possível falha: sem mensagens de clientes há ${Math.max(1, Math.floor(ms / 60_000))} min`;
}
