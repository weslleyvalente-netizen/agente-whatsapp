import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Strips the "55" (Brazil) country code and formats the remaining digits as
// (DDD) XXXXX-XXXX or (DDD) XXXX-XXXX — WhatsApp numbers arrive with the
// country code baked in, but showing it to users is just noise.
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  const local10 = digits.startsWith("55") && digits.length > 10 ? digits.slice(2) : digits;
  const ddd = local10.slice(0, 2);
  const number = local10.slice(2);
  if (ddd.length < 2 || number.length < 8) return phone;
  const numberFormatted =
    number.length === 9 ? `${number.slice(0, 5)}-${number.slice(5)}` : `${number.slice(0, 4)}-${number.slice(4)}`;
  return `(${ddd}) ${numberFormatted}`;
}

// Renders a numeric value (or null/undefined, when the field hasn't been
// filled in yet) as Brazilian currency, e.g. 5000 -> "R$ 5.000,00".
export function formatCurrencyBRL(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Não informado";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

// Renders how long ago an ISO timestamp was, e.g. "agora", "há 12 min",
// "há 3h", "há 2 dias". Falls back to an absolute date past ~30 days —
// "há 45 dias" stops being useful information at that point. Returns a
// fixed string for null/undefined (a task's conversation can be missing).
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Sem interações registradas";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `há ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `há ${diffDays} dia${diffDays === 1 ? "" : "s"}`;
  return new Date(iso).toLocaleDateString("pt-BR");
}
