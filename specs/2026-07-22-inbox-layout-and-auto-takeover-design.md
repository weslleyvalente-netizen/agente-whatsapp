# Inbox Layout Parity + Auto Human-Takeover on Manual Reply — Design

## Goal

Two changes, shipped together because the second only makes sense once the
first is real behavior, not just a label:

1. **Auto human-takeover:** when someone sends a message manually through
   the inbox composer, the conversation automatically flips to human
   takeover (the AI stops replying) — matching the user's explicit request:
   "quando o usuário responder pelo whatsapp a IA para de responder e se
   desliga, só liga se apertar pra religar." Turning it back on already
   works today (the existing "Devolver ao Agente" button).
2. **Inbox layout restructure**, matching the *structure* (not visual
   identity — the blueprint palette stays) of a reference product ("Assis")
   the user showed: filter tabs above the conversation list instead of a
   single status dropdown, primary conversation actions (status, takeover
   toggle) moved into the chat header instead of buried in the side panel,
   and a contextual notice above the composer that's now truthful because
   of change #1.

## Non-goals

- No new "assign to teammate" UI beyond what already exists (`TakeoverBar`'s
  select stays where it is, in the side panel).
- No change to Tags or Notes — they stay in the side panel, just below a
  now-shorter panel (Status and Atendimento move out).
- The "Atenção" filter tab intentionally does **not** replicate the
  Início page's precise "unanswered" refinement (see Data definitions
  below) — it's a broader, simpler definition chosen for this list.

## Part 1: Auto human-takeover on manual send

**File:** `apps/api/src/routes/messages/send.ts`

After the existing access check and before enqueueing the outbound send,
if the conversation is not already in takeover, update it exactly the way
`TakeoverBar`'s `handleTakeover` already does when a human clicks "Assumir
Conversa": `is_human_takeover: true`, `human_takeover_at: now`,
`assigned_to: <the sending user's id>`. If the conversation is *already*
in takeover, do nothing (don't reset `assigned_to` to whoever happens to
send the next message — the first responder keeps ownership).

This is the only backend change. No new endpoint, no schema change.

## Part 2: Inbox layout

### Filter tabs (replaces the single status `Select`)

**File:** `apps/web/src/app/(dashboard)/inbox/page.tsx`

Five tabs, client-side filters over the conversations already being
fetched (no new API calls):

| Tab | Definition |
|---|---|
| Todas | No filter (current default) |
| Minhas | `assigned_to === current user's id` |
| Agente | `is_human_takeover === false` (bot still handling) |
| Outros | `assigned_to !== null && assigned_to !== current user's id` |
| Atenção | `is_human_takeover === true` |

The current user's id is fetched once via `supabase.auth.getUser()`,
the same pattern `TakeoverBar` already uses.

### Row badges

**File:** `apps/web/src/components/inbox/conversation-list.tsx`

Each row keeps its existing status lamp + agent name. When
`is_human_takeover` is true, add one `Badge` (`variant="destructive"`,
label "Atenção Humana") after the agent name — the row-level signal that
a human owns this conversation.

### Chat header restructure

**Files:** `apps/web/src/components/inbox/chat-panel.tsx`,
`apps/web/src/components/inbox/chat-header.tsx` (new),
`apps/web/src/components/inbox/side-panel.tsx`

A new `ChatHeader` component renders: contact name, phone, agent name
(left side — what `chat-panel.tsx`'s header already shows today), and on
the right: the status `Select` (moved from `SidePanel`) and the
takeover toggle button (`TakeoverBar`'s button, *not* its "assign to
teammate" select — that stays in the side panel). `SidePanel` loses its
"Status" and "Atendimento" sections; `TakeoverBar` itself is unchanged as
a component, just rendered from two different places for its two pieces
(this task splits it, see Global Constraints).

### Notice bar above the composer

**File:** `apps/web/src/components/inbox/chat-panel.tsx`

When `!conversation.is_human_takeover`, render a bar above the message
input with a destructive/rust-tinted background (our palette's error
tone, not literally copying Assis's pink) containing exactly this copy:
"O agente está atendendo. Enviar uma mensagem atribui a conversa a você e
pausa o agente e as automações." It disappears once the conversation is
in takeover (either because someone clicked "Assumir Conversa" or, after
Part 1 ships, the moment they send their first message).

## Global Constraints

- Keep the existing blueprint visual identity (colors, type, radius) —
  this is a structural/layout change, not a re-skin.
- `TakeoverBar`'s "assign to teammate" `Select` stays in the side panel;
  only the takeover toggle *button* moves to the header. Splitting
  `TakeoverBar` into "the button" and "the assign select" is in scope for
  this task if needed to place them in two different components — don't
  duplicate the takeover-toggle network call in two places.
- The "Atenção" tab uses the simpler `is_human_takeover === true`
  definition (not the Início page's stricter "and unanswered" rule) —
  this is deliberate, not a bug: the Início KPI needs precision for an
  alert count, this list is for a human browsing everything they're
  already handling.
- No new backend endpoints for Part 2 — everything filters client-side
  over data the inbox page already fetches.
