export interface PendingOutboundCandidate {
  id: string;
  content: string;
  media_type: string | null;
  created_at: string;
}

export interface IncomingEcho {
  mediaType: string | null;
  content: string;
}

// Matches the Evolution echo of one of OUR outbound messages against the
// candidate rows still waiting for their evolution_message_id to be
// backfilled (see apps/worker/src/workers/send-message.ts) — used when the
// echo arrives at the webhook before that backfill completes, for ANY
// outbound message regardless of who/what sent it (Helena's own reply, a
// manual inbox reply, or a Task follow-up all race the same way).
//
// Media messages (audio/image/video/...) match by media_type alone: the
// echo's extracted content is a fixed placeholder (e.g. "[audio]" for any
// audioMessage — see extractByType in apps/api/src/routes/webhooks/
// evolution.ts), it never carries our real text/caption back reliably.
// Text messages (mediaType null) require exact content equality.
//
// Ties (two pending candidates that both match) resolve to the OLDEST one.
export function matchPendingOutboundMessage(
  candidates: PendingOutboundCandidate[],
  incoming: IncomingEcho
): PendingOutboundCandidate | null {
  const sorted = [...candidates].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  for (const candidate of sorted) {
    if (incoming.mediaType) {
      if (candidate.media_type === incoming.mediaType) return candidate;
    } else if (candidate.media_type === null && candidate.content === incoming.content) {
      return candidate;
    }
  }

  return null;
}
