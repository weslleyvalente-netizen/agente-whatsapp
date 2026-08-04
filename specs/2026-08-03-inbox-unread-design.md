# Inbox "Unread" Indicator — Design

## Goal

Give each attendant a reliable, per-person "unread" signal in the Inbox
conversation list, so a conversation with a new customer message or a fresh
Helena reply doesn't get silently skimmed past. Today the only proxy is the
`waiting` status's small amber `StatusLamp` dot, visually near-identical to
the `open` status's green dot, and easy to miss in a long list. The existing
`createTask` tool doesn't help either — it's an AI-judgment-gated follow-up
mechanism fully decoupled from the Inbox list and conversation status.

## Non-goals

- No unread counter in the sidebar nav or the browser tab title — scope is
  the Inbox conversation list only, for this pass. (user decision)
- No per-message read state, no "seen by" receipts visible to the customer
  — this is purely an internal attendant-facing signal.
- No change to the existing `status`/`is_human_takeover` badges or the
  `StatusLamp` component — unread is additive and orthogonal to status (a
  `resolved` conversation can still be "unread" if nobody opened it after
  the customer's last message).
- No explicit "mark as unread again" action in this pass — read state only
  moves forward (opening always marks read; there's no "remind me later"
  toggle). (user decision: automatic-on-open only)

## Confirmed current behavior (verified against source, not assumed)

**`conversations.last_message_at` does not update on every message today.**
It's set once at conversation creation
(`apps/api/src/services/conversation.service.ts:48`) and again only after
Helena successfully replies
(`apps/worker/src/workers/process-message.ts:245`). A customer message on an
already-open conversation, saved in the webhook's non-`fromMe` branch
(`apps/api/src/routes/webhooks/evolution.ts:152-160`), never touches
`last_message_at` — nor does a human agent's own WhatsApp reply, saved in
the `fromMe` branch (`evolution.ts:118-146`). This is a pre-existing gap
that also affects the Inbox list's sort order today (the list is ordered by
this field via `idx_conversations_org_last_msg`), not just this feature —
fixing it is in scope here because "unread" cannot be computed reliably
without an accurate last-activity timestamp.

**Correction (found during final review):** `conversations.last_message_at`
was already being bumped on every message via `saveMessage()` in
`apps/api/src/services/message.service.ts:39-42`, called by both webhook
branches — the original "Confirmed current behavior" claim above was based
on checking the webhook's call site but not `saveMessage`'s own body, and
was wrong. No fix was needed for this; the webhook-level updates this
design originally called for were reverted as redundant duplication.

**Multiple attendants share one Inbox.** `organization_members` (role:
owner/admin/member) and `conversations.assigned_to` already establish that
more than one human can work the same organization's conversations
(`supabase/migrations/00002_organizations.sql`,
`supabase/migrations/00007_conversations.sql:10`) — confirming unread state
must be tracked per attendant, not globally per conversation.

**RLS today applies a generic org-scoped policy to a fixed table list**
(`supabase/migrations/00008_rls_policies.sql:84-102`) — `organization_id IN
(SELECT get_user_org_ids())` for select/insert/update/delete, applied via a
loop requiring each table to have its own `organization_id` column.
`conversation_notes` is in that list and is therefore only org-scoped
today, not user-scoped, despite having a `user_id` column — any org member
can read/edit any other member's notes. `conversation_reads` (below)
deliberately does **not** join that generic loop, because its entire
purpose is per-user isolation: one attendant marking a conversation read
must never affect another attendant's unread state. It gets its own
dedicated policies instead (see Architecture).

## Architecture

### Schema

**Fix `last_message_at` maintenance** — update it on every new message, not
only Helena's replies:
- `apps/api/src/routes/webhooks/evolution.ts`: after `saveMessage` succeeds
  in both the `fromMe` branch and the normal contact-message branch, also
  call `updateConversation(db, conversation.id, { last_message_at: new
  Date().toISOString() })`.
- The existing update in `process-message.ts:245` (after Helena replies)
  stays as-is — it's already correct for that path.

**New table `conversation_reads`:**
```sql
CREATE TABLE conversation_reads (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_conversation_reads_user ON conversation_reads(user_id);
ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_reads_select" ON conversation_reads
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "conversation_reads_upsert" ON conversation_reads
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND conversation_id IN (
      SELECT id FROM conversations WHERE organization_id IN (SELECT get_user_org_ids())
    )
  );
CREATE POLICY "conversation_reads_update" ON conversation_reads
  FOR UPDATE USING (user_id = auth.uid());
```
One row per (conversation, attendant) pair; upserted (insert-or-update on
the same primary key) every time that attendant opens the conversation, or
while it stays open and a new message arrives in it.

### Marking as read

Client-side, when `ChatPanel` mounts for a given `conversationId` (or the
selected conversation changes), upsert `conversation_reads` with the
current authenticated user's id and `last_read_at = now()`. While that
conversation stays the selected one and a new message arrives via the
existing realtime subscription, upsert again — this keeps a conversation
the attendant is actively looking at from ever flashing "unread" the
instant Helena or the customer sends a new message into it.

### Computing "unread" in the list

The Inbox list already fetches the org's conversations. Alongside that,
fetch the current user's own `conversation_reads` rows once (`user_id =
current user`) into a `Map<conversation_id, last_read_at>`. Per conversation
row:
```
unread = last_message_at > (readMap.get(conversation.id) ?? "1970-01-01T00:00:00Z")
```
Pure timestamp comparison — no join against `messages` needed, since
`last_message_at` (now fixed above) is the authoritative last-activity
timestamp.

### Realtime

Two additions to the Inbox's existing realtime wiring (it already
subscribes to `messages` for the open conversation):
- Subscribe to `conversations` (`last_message_at` changes) for the org, so
  a new message flips a conversation's computed unread state live without
  a page reload.
- Subscribe to `conversation_reads` filtered to `user_id = current user`,
  so reading the same conversation from another tab or device clears the
  unread flag here too.

Both feed the same client-side `unread` computation above — no new state
machine, just two more triggers to recompute it.

## UI

In `apps/web/src/components/inbox/conversation-list.tsx`, when a
conversation's computed `unread` is `true`:
- Contact name renders `font-semibold` instead of the current
  `font-medium`.
- A small solid dot renders next to the timestamp (a new, distinct
  indicator — not a reuse of `StatusLamp`, since unread is orthogonal to
  `status`: a `resolved` conversation can still be unread).

When `unread` is `false`: exactly today's rendering, no dot, normal weight.

## Error handling

If the mark-as-read upsert fails (network, RLS misconfiguration), the
conversation simply stays flagged unread — fails safe, no UI blocking, and
it retries naturally the next time that attendant opens the conversation.

## Testing

- A pure function `isUnread(lastMessageAt: string, lastReadAt: string |
  undefined): boolean` is extracted and unit-tested: never read → `true`;
  read before the last message → `true`; read at/after the last message →
  `false`.
- The upsert-on-open behavior, the "stays read while open" behavior, the
  realtime wiring, and the RLS policies are verified manually against the
  real Supabase project — matching this codebase's established convention
  for this class of I/O-heavy, hard-to-unit-test behavior.
