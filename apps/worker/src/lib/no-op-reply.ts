// The system prompt tells the agent to leave the text reply truly empty
// when a customer's message needs no response (e.g. a bare "blz" after the
// topic is already closed). In production the model sometimes satisfies
// that instruction literally instead of with empty text — writing a short
// meta-comment like "(sem resposta necessária)" — and that placeholder gets
// sent to the customer instead of nothing. This treats a reply that is
// ONLY that kind of meta-commentary as equivalent to empty, without
// matching the phrase inside an otherwise real, substantive reply.
const NO_OP_REPLY_PATTERN =
  /^[\s*_~`"'()[\].-]*sem\s+(necessidade\s+de\s+)?(nova\s+)?resposta(\s+necess[aá]ria)?[\s*_~`"'()[\].-]*$/i;

export function isNoOpReply(text: string): boolean {
  return NO_OP_REPLY_PATTERN.test(text.trim());
}
