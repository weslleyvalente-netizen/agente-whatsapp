# Dashboard Home ("Início") — Design

## Goal

Replace the current behavior where `/` redirects straight into `/inbox`
with a real overview page — greeting, four KPI cards, and a list of
conversations that need human attention — so a business owner opens the
app and immediately sees what needs them, instead of landing cold in the
inbox with no context.

Inspired by the layout of a reference product ("Assis") the user showed,
adapted to our existing data model and design system (not copied
visually — we keep our own blueprint-console identity).

## Non-goals

- No Analytics page (separate future spec, per the user's stated
  priority order: Início first).
- No sidebar regrouping into labeled sections (separate future spec).
- No "Nova" tag / new-conversation highlighting — only the "Precisam de
  atenção" (Urgente) case defined below ships in this pass.
- No configurable time window — the 7-day window is fixed, matching the
  reference and keeping the first version simple.

## Architecture

`/` moves inside the `(dashboard)` route group and becomes the home
page, replacing `apps/web/src/app/page.tsx`'s redirect. It inherits the
existing `(dashboard)/layout.tsx` auth guard and sidebar — no new layout
plumbing needed. The sidebar gains an "Início" entry as the first nav
item, pointing at `/`.

A new API route, `GET /organizations/:organizationId/dashboard/summary`,
follows the same shape as the existing costs summary route
(`apps/api/src/routes/costs/index.ts`): fetch raw rows scoped to the
organization and a 7-day window, aggregate in JS, return one JSON
payload. No new SQL views or RPCs.

## Data definitions

All figures are computed over the last 7 days (`now - 7d` to `now`),
scoped to `organization_id`.

- **Conversas (7 dias):** count of distinct conversations with any
  message activity in the window (any row in `messages` with
  `created_at` in range, grouped by `conversation_id`).
- **Em andamento:** count of conversations currently in `status IN
  ('open', 'waiting')` — a live snapshot, not windowed by the 7 days.
- **Tempo de resposta:** average elapsed time between a `role='contact'`
  message and the next `role='agent'` message that follows it in the
  same conversation, restricted to pairs where the contact message falls
  in the 7-day window. Contact messages with no following agent message
  (still unanswered, or answered by a human) are excluded from the
  average — this metric is specifically about agent responsiveness.
- **Precisam de atenção:** count of conversations where
  `is_human_takeover = true` AND the most recent message in that
  conversation has `role = 'contact'` (a human took over and the contact
  has sent something since, with no reply yet). Not windowed — this is
  a live snapshot, since a stale unanswered handoff from 10 days ago is
  still worth surfacing.

## API response shape

```ts
interface DashboardSummary {
  conversationsLast7d: number;
  inProgress: number;
  avgResponseSeconds: number | null; // null when no answered pairs in window
  needsAttention: number;
  urgentConversations: Array<{
    conversationId: string;
    contactName: string | null;
    contactPhone: string;
    lastMessagePreview: string;
    lastMessageAt: string; // ISO timestamp
  }>;
}
```

`urgentConversations` is every conversation counted in `needsAttention`,
sorted oldest-first (the longest-waiting handoff surfaces first),
capped at 20 rows to keep the payload bounded.

## UI

**Header:** time-of-day greeting ("Bom dia" / "Boa tarde" / "Boa noite")
with a sun/moon glyph, and a subtitle with the full date in Portuguese
("Aqui está o que precisa da sua atenção hoje, terça-feira 21 de
julho.").

**KPI row:** four cards reusing the existing Card + `label-eyebrow` +
`tabular-data` treatment already established on the Custos page:
Conversas (7 dias), Em andamento, Tempo de resposta (formatted as
`Xm Ys` or `—` when null), Precisam de atenção. The last card shows a
`StatusLamp` (`rust` tone, pulsing) next to its number whenever the
count is greater than zero — real state, not decoration, consistent
with how the lamp is used everywhere else in the app.

**Tarefas urgentes card:** a list of `urgentConversations` rows — avatar
initial, contact name (falls back to phone), truncated last-message
preview, relative time ("há 7 h" — reuse or add a small relative-time
formatter), and a destructive-variant "Urgente" badge. Clicking a row
navigates to `/inbox?id={conversationId}`, matching the deep-link
pattern the inbox already supports.

**Empty state:** when `urgentConversations` is empty, the card shows a
calm one-line message instead of an empty list (e.g. "Nenhuma conversa
esperando atenção.").

## Testing

- API: unit-style tests for the aggregation function (pure JS, given a
  fixed array of conversation/message rows, assert the four numbers and
  the urgent list) — same style as `crm-sync.test.ts` already in the
  repo.
- Manual verification against real data in the running dev environment,
  the same way the Costs page was verified.
