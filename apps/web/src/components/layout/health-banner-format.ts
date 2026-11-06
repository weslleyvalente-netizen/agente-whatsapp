export interface HealthState {
  status: "ok" | "warning";
  reasons: string[];
  lastCustomerMessageAt: string | null;
}

const SILENCE_PREFIX = "Sem mensagens de clientes";

/** Título da faixa: texto de silêncio só quando há motivo de silêncio; senão "Possível falha: <motivo>". */
export function bannerTitle(health: HealthState, now: number = Date.now()): string {
  const hasSilence = health.reasons.some((r) => r.startsWith(SILENCE_PREFIX));
  if (!hasSilence) return `Possível falha: ${health.reasons[0] ?? "verifique o sistema"}`;
  if (!health.lastCustomerMessageAt) return "Possível falha: nenhuma mensagem de cliente registrada";
  const ms = now - Date.parse(health.lastCustomerMessageAt);
  if (!Number.isFinite(ms) || ms < 0) return "Possível falha no recebimento de mensagens";
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1
    ? `Possível falha: sem mensagens de clientes há ${hours} h`
    : `Possível falha: sem mensagens de clientes há ${Math.max(1, Math.floor(ms / 60_000))} min`;
}

/** Motivos que ainda não aparecem no título. */
export function extraReasons(health: HealthState, title: string): string[] {
  return health.reasons.flatMap((r) => {
    if (!r.startsWith(SILENCE_PREFIX)) return title.includes(r) ? [] : [r];
    // Causa provável vem depois de "; " na mensagem de silêncio: o painel mostra a mesma orientação do aviso.
    const i = r.indexOf("; ");
    if (i < 0) return [];
    const hint = r.slice(i + 2);
    return [hint.charAt(0).toUpperCase() + hint.slice(1)];
  });
}
