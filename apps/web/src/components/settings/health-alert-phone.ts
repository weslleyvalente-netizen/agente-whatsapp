/** Aceita "+55 (62) 99999-8888" etc. Vazio vira null (sem WhatsApp, só a faixa no painel). Exige DDI: 10 a 15 dígitos. */
export function normalizeAlertPhone(input: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, value: null };
  if (/[^\d\s()+\-.]/.test(trimmed)) return { ok: false, error: "Use apenas números, com DDI (ex.: 5562999998888)." };
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return { ok: false, error: "Número inválido: informe DDI + DDD + número (ex.: 5562999998888)." };
  return { ok: true, value: digits };
}
