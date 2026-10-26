// Brazilian mobile numbers migrated to a 9-digit subscriber number (a
// leading "9" before the old 8-digit number), but WhatsApp/Evolution's
// registered JID for a contact doesn't always agree with how a customer
// types their own number elsewhere (e.g. on a website form) — the same
// real phone can show up as "5562996807555" (with the 9) in one place and
// "556296807555" (without it) in another. Matching contacts by exact phone
// string then creates duplicate contacts/conversations for the same
// person, losing all prior context.
//
// Returns the other valid representation of a Brazilian phone (55 + DDD +
// subscriber number), or null if `phone` isn't shaped like one.
export function brazilPhoneAlternate(phone: string): string | null {
  if (!phone.startsWith("55")) return null;
  const rest = phone.slice(2);

  if (rest.length === 11 && rest[2] === "9") {
    return `55${rest.slice(0, 2)}${rest.slice(3)}`;
  }
  if (rest.length === 10) {
    return `55${rest.slice(0, 2)}9${rest.slice(2)}`;
  }
  return null;
}

// All phone strings that could refer to the same real contact as `phone`,
// including `phone` itself.
export function brazilPhoneVariants(phone: string): string[] {
  const alternate = brazilPhoneAlternate(phone);
  return alternate ? [phone, alternate] : [phone];
}

// Chave canônica para COMPARAR telefones: ignora formatação, "+", código do país e o 9º dígito.
// Número brasileiro (55 + 12/13 dígitos, ou nacional com 10/11) vira DDD + últimos 8 dígitos;
// qualquer outro número usa os dígitos completos.
export function phoneMatchKey(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return digits.slice(2, 4) + digits.slice(-8);
  }
  // Nacional sem 55: 11 dígitos só se o 3º for 9 (celular); 10 dígitos se o 3º for 2-9.
  if ((digits.length === 11 && digits[2] === "9") || (digits.length === 10 && /[2-9]/.test(digits[2]))) {
    return digits.slice(0, 2) + digits.slice(-8);
  }
  return digits;
}

export function samePhoneNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = phoneMatchKey(a);
  return x !== "" && x === phoneMatchKey(b);
}
