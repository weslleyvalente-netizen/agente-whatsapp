// Confirmed in production: the model sometimes narrates its own message
// lifecycle instead of just replying — e.g. writing "A resposta já foi
// enviada" as if reporting on itself rather than answering the customer.
// This is not a fixed system string (no code ever generates it) — the
// model invents it — so no simple exact-match guard covers it upstream.
//
// Unlike isNoOpReply (no-op-reply.ts), which only fires when the ENTIRE
// message is a placeholder, this strips a leaked fragment out of an
// otherwise legitimate reply, so a real answer that happens to sit next to
// one of these phrases isn't thrown away — only the leaked part is.
const META_NARRATION_PATTERNS = [
  /a\s+resposta\s+j[aá]\s+foi\s+enviada\.?/gi,
  /j[aá]\s+enviei\s+(a\s+)?resposta\.?/gi,
  /j[aá]\s+respondi\s+isso\.?/gi,
];

export function stripLeakedMetaNarration(text: string): string {
  let result = text;
  for (const pattern of META_NARRATION_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.replace(/[ \t]{2,}/g, " ").replace(/\s+([.!?])/g, "$1").trim();
}
