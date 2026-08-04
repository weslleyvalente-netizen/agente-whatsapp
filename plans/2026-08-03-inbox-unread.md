# Inbox Unread Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each attendant a reliable, per-person "unread" signal in the Inbox conversation list — bold name + dot when there's a message (from the customer or Helena) since that attendant last opened the conversation — so it's no longer easy to skim past a conversation that needs a look.

**Architecture:** A new `conversation_reads` table (one row per attendant per conversation, holding `last_read_at`) drives the computation `unread = last_message_at > last_read_at`. Because `conversations.last_message_at` today is only bumped when Helena replies — never on a plain customer message or a human's own WhatsApp reply — the webhook is fixed first so that field becomes a trustworthy last-activity timestamp for every message type. The dashboard (already fetching/subscribing to `conversations` and `messages` directly via the Supabase browser client, no separate backend API layer for these reads) gains one more direct table (`conversation_reads`): `ChatPanel` upserts into it when a conversation is opened and while it stays open; `InboxPage` reads the current user's own rows into a map and computes `unread` per conversation to pass down to `ConversationList` for rendering.

**Tech Stack:** Postgres/Supabase (new migration + RLS), Next.js 16 client components (existing pattern: `"use client"`, `createClient()` from `@/lib/supabase/client`, `useRealtime` hook), vitest for the one pure helper this feature introduces (`packages/shared`, which already has a vitest setup — `apps/web` has none, so no new frontend test infra is added; frontend behavior here is verified manually against the running dev server, matching this codebase's existing convention for `apps/web`).

## Global Constraints

- `conversation_reads` schema, exact: `conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE`, `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`, `last_read_at timestamptz NOT NULL DEFAULT now()`, `PRIMARY KEY (conversation_id, user_id)`. (spec, Architecture > Schema)
- `conversation_reads` gets its **own dedicated RLS policies** (`user_id = auth.uid()`, plus an org-membership check on insert), **not** the generic per-table loop in `supabase/migrations/00008_rls_policies.sql:84-102` — that loop only enforces org scoping via an `organization_id` column this table doesn't have, and would not give per-user isolation. (spec, Confirmed current behavior)
- `last_message_at` must be bumped on every new message going forward — customer messages (`apps/api/src/routes/webhooks/evolution.ts`'s non-`fromMe` branch), a human's own WhatsApp reply (the `fromMe` branch), and Helena's replies (already correct, `apps/worker/src/workers/process-message.ts:245` — do not touch that file). (spec, Architecture > Schema)
- Unread computation is a pure timestamp comparison, no query against `messages`: `unread = last_message_at > (last_read_at ?? epoch)`. (spec, Architecture > Computing "unread")
- Marking as read happens automatically on opening a conversation, and again on every new message while that conversation stays open — no manual "mark as read/unread" control in this pass. (spec, Non-goals; Architecture > Marking as read)
- Scope is the Inbox conversation list only — no unread counter in the sidebar nav or browser tab title in this pass. (spec, Non-goals)
- `apps/web` runs on Next.js 16 with breaking changes from prior versions per `apps/web/AGENTS.md` — this plan's frontend changes only extend existing client-component patterns already used verbatim elsewhere in the same files being touched (state/effects/`useRealtime`/direct Supabase calls), so no new Next.js APIs are introduced and no doc lookup should be needed; if a step's approach doesn't work as written, check `apps/web/AGENTS.md` before improvising a different pattern.

---

### Task 1: `conversation_reads` table and RLS policies

**Files:**
- Create: `supabase/migrations/00018_conversation_reads.sql`

**Interfaces:**
- Produces: table `conversation_reads(conversation_id, user_id, last_read_at)`, primary key `(conversation_id, user_id)`. Task 4 upserts and selects against this table directly via the Supabase browser client — no query-layer function is added for it (matches the existing pattern: `apps/web` reads/writes `conversations`/`messages` directly, no `packages/database` wrapper for those either, from the dashboard).

This project has no local Supabase CLI/Docker setup (verified: no `supabase/config.toml`, `supabase` binary not on PATH) — migrations are applied directly against the real Supabase project's SQL editor, the same way every other migration in `supabase/migrations/` has been. There is no automated migration test in this repo; verification is manual against the real project, matching the codebase's established convention for this class of change.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/00018_conversation_reads.sql`:

```sql
CREATE TABLE conversation_reads (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_conversation_reads_user ON conversation_reads(user_id);

ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;

-- Each attendant can only ever see their own read state.
CREATE POLICY "conversation_reads_select" ON conversation_reads
  FOR SELECT USING (user_id = auth.uid());

-- Insert (first time a user opens a conversation): must be marking their
-- own row, for a conversation in an org they belong to.
CREATE POLICY "conversation_reads_insert" ON conversation_reads
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND conversation_id IN (
      SELECT id FROM conversations WHERE organization_id IN (SELECT get_user_org_ids())
    )
  );

-- Update (re-opening, or a new message arriving while open): same
-- ownership check; Postgres reuses USING as the WITH CHECK when none is
-- given, so this also prevents changing the row's own user_id via update.
CREATE POLICY "conversation_reads_update" ON conversation_reads
  FOR UPDATE USING (user_id = auth.uid());
```

`get_user_org_ids()` already exists (`supabase/migrations/00008_rls_policies.sql:18-21`) — no new helper function needed.

- [ ] **Step 2: Apply the migration to the real Supabase project**

Open the Supabase project's SQL editor (dashboard) and run the contents of `supabase/migrations/00018_conversation_reads.sql`.

Expected: no errors; a new `conversation_reads` table appears in the Table Editor with RLS enabled (shown as "RLS enabled" badge) and three policies listed under Authentication > Policies for that table.

- [ ] **Step 3: Verify RLS manually**

In the SQL editor, run as a normal authenticated role is hard to simulate directly in the SQL editor (it runs as `postgres`/service role, which bypasses RLS) — instead, verify structurally:

```sql
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'conversation_reads';
```

Expected: three rows (`conversation_reads_select`, `conversation_reads_insert`, `conversation_reads_update`), each with `qual`/`with_check` referencing `auth.uid()`. Full behavioral verification (a user really can only see their own rows) happens naturally in Task 4's manual verification, once the dashboard is actually calling this table under a real logged-in session.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00018_conversation_reads.sql
git commit -m "feat: add conversation_reads table for per-attendant unread tracking"
```

---

### Task 2: Bump `last_message_at` on every message, not just Helena's replies

> **Reverted during final review (this task is now a no-op, kept as historical record):**
> `saveMessage()` (`apps/api/src/services/message.service.ts:39-42`) already
> bumps `conversations.last_message_at` unconditionally on every call, and is
> called by both webhook branches this task modified — so the updates added
> here were pure duplication (double `conversations` UPDATEs, double
> realtime broadcasts, extra failure surface). The `evolution.ts` changes
> below were reverted; see the "Correction" note in
> `specs/2026-08-03-inbox-unread-design.md`'s "Confirmed current behavior"
> section for the full explanation.

**Files:**
- Modify: `apps/api/src/routes/webhooks/evolution.ts`

**Interfaces:**
- Consumes: `updateConversation(client: SupabaseClient, id: string, updates: Partial<Conversation>)` — already imported in this file (`apps/api/src/routes/webhooks/evolution.ts:3`) and already called once in the `fromMe` branch.
- No new exports — this task only changes what fields are passed to two existing/one new `updateConversation` call.

This file has no test coverage for the route handler itself (only the pure `extractMessageContent` function is unit-tested, in `evolution.test.ts`) — matches this file's existing precedent (the `fromMe` branch and the enqueue logic are likewise untested). Verification is manual, in Task 4's end-to-end check.

- [ ] **Step 1: Fold `last_message_at` into the existing `fromMe`-branch update**

In `apps/api/src/routes/webhooks/evolution.ts`, change (around line 140-143):

```ts
        await updateConversation(getAdminClient(), conversation.id, {
          is_human_takeover: true,
          human_takeover_at: new Date().toISOString(),
        });
```

to:

```ts
        await updateConversation(getAdminClient(), conversation.id, {
          is_human_takeover: true,
          human_takeover_at: new Date().toISOString(),
          last_message_at: new Date().toISOString(),
        });
```

- [ ] **Step 2: Add a `last_message_at` update to the contact-message branch**

In the same file, change (around line 163-171):

```ts
      // If message was already processed (duplicate webhook), skip
      if (!message) {
        return reply.status(200).send({ ok: true, skipped: "duplicate" });
      }

      // If human takeover is active, don't enqueue for LLM processing
      if (conversation.is_human_takeover) {
        return reply.status(200).send({ ok: true, skipped: "human_takeover" });
      }
```

to:

```ts
      // If message was already processed (duplicate webhook), skip
      if (!message) {
        return reply.status(200).send({ ok: true, skipped: "duplicate" });
      }

      // Bump last-activity so the Inbox list's sort order and unread
      // indicator reflect this message immediately, regardless of whether
      // the agent ends up replying (human takeover may skip that below).
      await updateConversation(getAdminClient(), conversation.id, {
        last_message_at: new Date().toISOString(),
      });

      // If human takeover is active, don't enqueue for LLM processing
      if (conversation.is_human_takeover) {
        return reply.status(200).send({ ok: true, skipped: "human_takeover" });
      }
```

- [ ] **Step 3: Run the existing test suite and typecheck**

Run: `cd apps/api && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS, no type errors — this change doesn't touch `extractMessageContent` or its tests, so all existing tests should be unaffected.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/webhooks/evolution.ts
git commit -m "fix: bump conversations.last_message_at on every message, not just AI replies"
```

---

### Task 3: `isUnread` pure helper

**Files:**
- Modify: `packages/shared/src/conversation-helpers.ts`
- Test: `packages/shared/src/conversation-helpers.test.ts`

**Interfaces:**
- Produces: `isUnread(lastMessageAt: string, lastReadAt: string | undefined): boolean`, exported from `packages/shared/src/conversation-helpers.ts` and re-exported via `packages/shared/src/index.ts`'s existing `export * from "./conversation-helpers.js"` (no change needed to `index.ts` — the wildcard export already covers it). Task 4 imports this as `import { isUnread } from "@aula-agente/shared"`.

This mirrors the existing `isHumanTakeoverExpired` in the same file exactly — same file, same "pure function, unit-tested, no I/O" shape.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/conversation-helpers.test.ts` (new `describe` block, after the existing `isHumanTakeoverExpired` one):

```ts
import { isUnread } from "./conversation-helpers.js";

describe("isUnread", () => {
  it("is true when the conversation has never been read", () => {
    expect(isUnread("2026-08-03T12:00:00Z", undefined)).toBe(true);
  });

  it("is true when the last message came after the last read", () => {
    expect(isUnread("2026-08-03T12:05:00Z", "2026-08-03T12:00:00Z")).toBe(true);
  });

  it("is false when the last read was after the last message", () => {
    expect(isUnread("2026-08-03T12:00:00Z", "2026-08-03T12:05:00Z")).toBe(false);
  });

  it("is false when read exactly at the last message timestamp", () => {
    expect(isUnread("2026-08-03T12:00:00Z", "2026-08-03T12:00:00Z")).toBe(false);
  });
});
```

(This adds a second `import` line for `isUnread` from the same module already imported at the top of the file for `isHumanTakeoverExpired` — combine them into one import statement: `import { isHumanTakeoverExpired, isUnread } from "./conversation-helpers.js";`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm exec vitest run src/conversation-helpers.test.ts`
Expected: FAIL — `isUnread` is not exported yet.

- [ ] **Step 3: Add the function**

In `packages/shared/src/conversation-helpers.ts`, add after `isHumanTakeoverExpired`:

```ts
// A conversation is "unread" for a given attendant when its last activity
// is newer than that attendant's last visit — or they've never visited it
// at all (lastReadAt undefined). Pure timestamp comparison: the caller is
// responsible for keeping lastMessageAt accurate (see the last_message_at
// fix in the webhook) and for looking up the right attendant's lastReadAt.
export function isUnread(lastMessageAt: string, lastReadAt: string | undefined): boolean {
  if (!lastReadAt) return true;
  return new Date(lastMessageAt).getTime() > new Date(lastReadAt).getTime();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm exec vitest run src/conversation-helpers.test.ts`
Expected: PASS (8 tests: 4 existing `isHumanTakeoverExpired` + 4 new `isUnread`).

Then typecheck and build (other packages import `@aula-agente/shared` from its built `dist/`, per the workspace's `main: "./dist/index.js"` convention):

Run: `cd packages/shared && pnpm exec tsc --noEmit && pnpm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/conversation-helpers.ts packages/shared/src/conversation-helpers.test.ts
git commit -m "feat: add isUnread pure helper for the Inbox unread indicator"
```

---

### Task 4: Wire the unread indicator into the Inbox UI

**Files:**
- Modify: `apps/web/src/app/(dashboard)/inbox/page.tsx`
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`
- Modify: `apps/web/src/components/inbox/conversation-list.tsx`

**Interfaces:**
- Consumes: `isUnread(lastMessageAt: string, lastReadAt: string | undefined): boolean` from `@aula-agente/shared` (Task 3). The `conversation_reads` table (Task 1) and the now-accurate `conversations.last_message_at` (Task 2).
- No new exports — this task is pure UI wiring, verified manually (this codebase has no test infra in `apps/web`).

- [ ] **Step 1: Fetch the current user's read state in `InboxPage` and compute `unread` per conversation**

In `apps/web/src/app/(dashboard)/inbox/page.tsx`, add the import and a `readMap` state next to the existing `conversations`/`userId` state:

```ts
import { isUnread } from "@aula-agente/shared";
```

```ts
  const [readMap, setReadMap] = useState<Map<string, string>>(new Map());
```

Add a fetch function next to `fetchConversations`:

```ts
  const fetchReads = useCallback(async () => {
    if (!userId) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("conversation_reads")
      .select("conversation_id, last_read_at")
      .eq("user_id", userId);
    setReadMap(new Map((data || []).map((r) => [r.conversation_id, r.last_read_at])));
  }, [userId]);
```

Call it once `userId` is known, and re-subscribe to keep it live (place this `useEffect` and `useRealtime` call right after the existing conversations `useRealtime` block):

```ts
  useEffect(() => {
    fetchReads();
  }, [fetchReads]);

  // Keeps this attendant's own read state in sync if they read the same
  // conversation from another tab/device.
  useRealtime({
    table: "conversation_reads",
    filter: userId ? `user_id=eq.${userId}` : undefined,
    onInsert: () => fetchReads(),
    onUpdate: () => fetchReads(),
    enabled: !!userId,
  });
```

Finally, attach `unread` to each conversation before it reaches `ConversationList`. Change:

```ts
  const filtered = conversations.filter((c) => {
```

to compute unread first, then filter:

```ts
  const withUnread = conversations.map((c) => ({
    ...c,
    unread: isUnread(c.last_message_at, readMap.get(c.id)),
  }));

  const filtered = withUnread.filter((c) => {
```

And update the two references to `conversations` inside `matchesTab`/`filtered`'s body that read `c...` — no change needed there, they still destructure from the same object shape, just with one extra `unread` field now present. The only other place `conversations`/`filtered` is used is the `<ConversationList conversations={filtered} .../>` JSX call further down, which needs no change — it already passes `filtered` through as-is.

- [ ] **Step 2: Mark as read when `ChatPanel` opens a conversation, and keep it read while open**

In `apps/web/src/components/inbox/chat-panel.tsx`, add a `userId` state and a fetch-once effect (mirrors the pattern in `apps/web/src/app/(dashboard)/inbox/page.tsx`, and the inline `supabase.auth.getUser()` call already used in this same file's `handleTakeoverToggle`):

```ts
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);
```

Add a `markAsRead` callback next to `fetchMessages`/`fetchConversation`:

```ts
  const markAsRead = useCallback(async () => {
    if (!userId) return;
    const supabase = createClient();
    await supabase
      .from("conversation_reads")
      .upsert(
        { conversation_id: conversationId, user_id: userId, last_read_at: new Date().toISOString() },
        { onConflict: "conversation_id,user_id" }
      );
  }, [conversationId, userId]);
```

Call it alongside the existing fetch-on-mount effect:

```ts
  useEffect(() => {
    fetchMessages();
    fetchConversation();
  }, [fetchMessages, fetchConversation]);
```

becomes:

```ts
  useEffect(() => {
    fetchMessages();
    fetchConversation();
  }, [fetchMessages, fetchConversation]);

  useEffect(() => {
    markAsRead();
  }, [markAsRead]);
```

And call it again inside the existing message realtime handler, so a message arriving while this conversation is open never leaves it flagged unread:

```ts
  // Realtime messages
  useRealtime<Message>({
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`,
    onInsert: (newMsg) => {
      setMessages((prev) => [...prev, newMsg]);
    },
    onUpdate: (updatedMsg) => {
      setMessages((prev) => prev.map((m) => (m.id === updatedMsg.id ? updatedMsg : m)));
    },
  });
```

becomes:

```ts
  // Realtime messages
  useRealtime<Message>({
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`,
    onInsert: (newMsg) => {
      setMessages((prev) => [...prev, newMsg]);
      markAsRead();
    },
    onUpdate: (updatedMsg) => {
      setMessages((prev) => prev.map((m) => (m.id === updatedMsg.id ? updatedMsg : m)));
    },
  });
```

- [ ] **Step 3: Render the unread state in `ConversationList`**

In `apps/web/src/components/inbox/conversation-list.tsx`, add `unread: boolean` to the `ConversationItem` interface:

```ts
interface ConversationItem {
  id: string;
  status: string;
  is_human_takeover: boolean;
  last_message_at: string;
  tags: string[];
  assigned_to: string | null;
  unread: boolean;
  wa_contacts: {
    phone: string;
    name: string | null;
  };
  agents: {
    name: string;
  };
  messages?: Array<{ content: string; created_at: string }>;
}
```

Change the name/timestamp row to react to `conv.unread`:

```tsx
              <p className="truncate text-sm font-medium">
                {conv.wa_contacts.name || formatPhone(conv.wa_contacts.phone)}
              </p>
              <span className="shrink-0 text-xs text-muted-foreground tabular-data">
                {new Date(conv.last_message_at).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
```

becomes:

```tsx
              <p className={cn("truncate text-sm", conv.unread ? "font-semibold" : "font-medium")}>
                {conv.wa_contacts.name || formatPhone(conv.wa_contacts.phone)}
              </p>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-data">
                {conv.unread && <span className="h-2 w-2 rounded-full bg-primary" aria-label="Não lida" />}
                {new Date(conv.last_message_at).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
```

(`cn` is already imported at the top of this file.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/inbox/page.tsx apps/web/src/components/inbox/chat-panel.tsx apps/web/src/components/inbox/conversation-list.tsx
git commit -m "feat: show a per-attendant unread indicator in the Inbox list"
```

- [ ] **Step 6: Verify live**

This task depends on Tasks 1-3 already applied/deployed (the `conversation_reads` table must exist; `apps/api` must be redeployed with the `last_message_at` fix; `apps/web` needs its dev server restarted or redeployed to pick up the `@aula-agente/shared` rebuild from Task 3).

Run `apps/web` locally (`cd apps/web && pnpm dev`) with two different logged-in dashboard users (or the same user in two browser profiles, if only one exists) who are both members of the same organization:

1. Send a WhatsApp message from the safe test number. Confirm: the conversation shows bold name + dot for both attendants who haven't opened it.
2. Attendant A opens the conversation. Confirm: it un-bolds and the dot disappears for A, but stays bold+dotted for attendant B (per-attendant isolation — this is the core thing Approach 3/the jsonb alternative would have gotten wrong).
3. While attendant A still has it open, send another WhatsApp message that triggers a Helena reply. Confirm: it does **not** flash unread for A (still looking at it), but does show unread for B.
4. Attendant B opens it. Confirm: unread clears for B too.
5. After attendant A reads a conversation, have them click away to a different conversation, then back. Confirm: the first conversation stays un-bolded (not just while it was the open/selected one) — this catches a stale-`readMap` regression if `conversation_reads` realtime isn't actually wired up.
6. Reload attendant A's page entirely (fresh mount, not just re-selecting). Confirm: still shows as read for A (state persisted server-side, not just in React state).
