// Negócio anulado (status 'void'): regras de tela. A API e o banco conferem de novo (só gestor, motivo 10–500).
export function voidActions(status: string, isManager: boolean) {
  const isVoid = status === "void";
  return { canVoid: isManager && !isVoid, canUnvoid: isManager && isVoid, isVoid };
}

export function voidReasonError(reason: string): string | null {
  const r = reason.trim();
  if (r.length < 10) return "Explique o motivo com pelo menos 10 caracteres.";
  if (r.length > 500) return "Motivo muito longo (máximo 500 caracteres).";
  return null;
}

export const statusLabel = (status: string): string =>
  status === "won" ? "Ganho" : status === "lost" ? "Perdido" : status === "void" ? "Anulado" : "Em andamento";
