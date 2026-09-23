import type { Message } from "@aula-agente/shared";

// Everything the customer sent since our last reply is one turn: find the
// most recent non-contact message (agent/human_agent/system) in the window
// and return every 'contact' message after it, oldest first. This is what
// turns rapid consecutive bubbles ("oi" / "tudo bem?" / "quero saber sobre
// a fazer 250") into one agent turn instead of one reply per bubble.
//
// This also gives retries and stray duplicate jobs their idempotency for
// free: once a reply has been created, it becomes the new "last non-contact
// message", so a second run over the same conversation finds nothing
// pending and does nothing — no extra query or dedup table needed.
export function collectPendingContactMessages(recentMessages: Message[]): Message[] {
  let lastNonContactIndex = -1;
  recentMessages.forEach((message, index) => {
    if (message.role !== "contact") {
      lastNonContactIndex = index;
    }
  });
  return recentMessages.slice(lastNonContactIndex + 1).filter((message) => message.role === "contact");
}

// False means a fresher customer message arrived while the agent was still
// generating this reply — the reply is stale (it never saw what the
// customer just said) and must be dropped, not sent. Nothing is lost: the
// newer message triggered its own debounced job, which will recompute the
// full pending batch (via collectPendingContactMessages) including
// whatever this dropped reply would have answered.
export function isReplyStillFresh(
  batchLastMessageCreatedAt: string,
  latestContactMessageCreatedAt: string | null
): boolean {
  if (!latestContactMessageCreatedAt) return true;
  return new Date(latestContactMessageCreatedAt).getTime() <= new Date(batchLastMessageCreatedAt).getTime();
}
