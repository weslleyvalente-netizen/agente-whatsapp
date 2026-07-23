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
