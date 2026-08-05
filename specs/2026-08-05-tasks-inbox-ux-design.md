# Tasks Inbox UX Redesign — Design

## Goal

Redesign the "Tarefas" screen's presentation layer so a salesperson can scan
dozens of tasks the way they'd scan an email/CRM inbox (HubSpot, Pipedrive,
Gmail, Assis), then use the side panel as their real work surface. This is a
**pure UI/UX pass** on top of the task-detail-panel feature that just
shipped — no database, endpoint, business-rule, or Helena-behavior changes.

## Non-goals (explicit — do not touch)

- No migration, no schema change, no new column.
- No new or modified API route. Every existing call
  (`GET /tasks/:id/details`, `PATCH /conversations/:id/qualification`,
  `POST /tasks/:id/complete`, `POST /tasks/:id/reschedule`,
  `POST /tasks/:id/cancel`, the `TaskDialog` PATCH) is reused exactly as-is —
  only *where in the UI* they're triggered from changes.
- No change to `human_locked_fields` semantics, the CPF replace-and-audit
  rule, or any other rule in `packages/database/src/queries/*`.
- No change to how Helena's `update_qualification` tool writes data.
- No change to `packages/shared` business logic (`isHotLead`,
  `sortTasksForToday`, `resolveTaskBucket`, `computeTaskSummary`) — this
  redesign only changes how their existing outputs are *rendered*.

## Current state (verified against source)

- `apps/web/src/components/tasks/task-card.tsx`: each task renders as a tall
  bordered card — 4 lines of text plus a column of up to 5 action buttons
  (Abrir conversa, Concluir, Reagendar via `RescheduleDialog`, Editar via
  `TaskDialog`, Cancelar). The whole card has no click-to-select affordance
  beyond the newly-added `onOpenDetails` on the text block.
- `apps/web/src/components/tasks/task-list.tsx`: groups by 🔥 Leads
  quentes / 🟡 Follow-ups (bucket `"today"` only) or a flat list otherwise;
  purely a `.map()` over `TaskCard`, no virtualization concerns at current
  volumes.
- `apps/web/src/components/tasks/task-detail-panel.tsx`: a `Sheet`
  (`sm:max-w-md`) with a linear stack of always-open sections (Resumo,
  Dados do cliente, Informações comerciais, Financiamento-if-applicable),
  each rendered by `QualificationSection`. Actions today: Abrir conversa,
  WhatsApp, Concluir — **Reagendar and Cancelar do not exist here**, they
  only exist on the list card being replaced.
- `apps/web/src/components/tasks/qualification-section.tsx`: per-section
  read/edit toggle with a text "Editar" button; `draftToPatch` only sends
  changed fields (existing human-lock-preserving behavior — untouched).
- `apps/web/src/app/(dashboard)/tasks/page.tsx`: holds `tab` (bucket filter)
  and `selectedTaskId` as sibling `useState`s — opening/closing the panel
  already doesn't touch `tab`, `tasks`, or scroll position structurally;
  this redesign must not regress that.
- Design system: no accordion/collapsible primitive exists yet.
  `@base-ui/react@1.6.0` (already a dependency) ships `accordion` — unused
  so far. `ui/dropdown-menu.tsx` already exists and is reused for the
  secondary-actions menu. No relative-time formatter exists anywhere in the
  app (`conversation-list.tsx` uses absolute `toLocaleTimeString`) — a small
  new one is added for "há 12 min" / "há 3h" / "há 2 dias" style labels.

## List redesign

### Row anatomy (replaces the current card)

```
┃ Marilene Souza                    [🔥 Quente] [Alta] [Aberta]
┃ Financiamento
┃ Cliente quer financiar moto XRE300, já tem entrada de R$5.000...
┃ Helena · Vence hoje 14:00 · Última interação há 12 min
```

- **Line 1** — name + right-aligned badge cluster: a discrete "🔥 Quente"
  badge (`Badge variant="tonal"` with a small flame icon, e.g.
  `lucide-react`'s `Flame`) **only when `isHotLead()` is true** — never an
  emoji glued to the name — followed by priority and status badges
  (`TASK_PRIORITY_LABELS` / `TASK_STATUS_LABELS`, same source of truth as
  today).
- **Line 2** — attendance type / task type label (`TASK_TYPE_LABELS[task.type]`).
- **Line 3** — `task.description`, clamped with `line-clamp-2` (Tailwind
  v4's built-in `line-clamp` utility, already used elsewhere in this app,
  e.g. `ui/select.tsx`) — hard cap at 2 lines, never more.
- **Line 4** — assignee (`assigneeLabel`, unchanged logic) · **due date**
  · **time since last interaction** (`há 12 min`, from
  `conversations.last_message_at` via the new relative-time helper). These
  are two distinct pieces of information and both are always shown — a task
  can be overdue while the customer replied five minutes ago, and the row
  must make both readable at a glance. Due-date formatting (reuses today's
  `toLocaleDateString("pt-BR")` logic, just relabeled): `Vence hoje` /
  `Vence hoje 14:00` (when `due_time` is set) / `Vence amanhã` / `Vence
  12/08` for a future date beyond tomorrow, or `Venceu 12/08` when the date
  is in the past (mirrors the existing "Atrasadas" bucket concept, just
  spelled out on the row instead of only being implied by which tab you're
  on).
- **No buttons.** The entire row is the click target (`onOpenDetails`,
  already wired) — Abrir conversa/Concluir/Reagendar/Editar/Cancelar are
  removed from the list entirely and now live only in the panel (see below).
- **Selected state** — while a task's panel is open, its row gets a
  persistent left accent bar + tinted background, reusing the exact visual
  language `app-sidebar.tsx` already uses for the active nav item
  (`absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary` on top of a
  `bg-accent/40` row background) — no new visual pattern introduced.
- Density: smaller padding (`p-3` instead of `p-4`), `text-sm`/`text-xs`
  throughout, tighter `space-y-0.5` between lines. The 🔥/🟡 group headers
  in the "today" bucket are kept as-is (`text-sm font-semibold`), they
  already help scanning and cost no extra height per row.

### Relative-time helper

A small pure function added to `apps/web/src/lib/utils.ts`,
`formatRelativeTime(iso: string): string`, returning `"agora"` / `"há N
min"` / `"há N h"` / `"há N dias"` / falls back to an absolute date past
~30 days. Presentation-only, no business logic, covered by unit tests.

## Panel redesign

### Header (enriched, height-neutral)

```
Marilene Souza                                    [✎] [✕]
(62) 8428-1880  ·  Financiamento
[Alta prioridade]                    há 12 min
```

- Name + a small pencil icon (`Pencil`, replaces the old text "Editar" that
  lived on the list's `TaskDialog` trigger) that opens the **same
  `TaskDialog`** used today, unchanged, for editing the task's own fields
  (type, priority, assignee, due date, description) — this is a different
  edit target than the qualification sections below.
- Phone (unchanged) · attendance type on the same line (new).
- Priority badge + "time since last interaction" on one compact line (new) —
  due date isn't repeated here since it's the reason the task exists at all
  and is already visible in the list; the panel's header optimizes for "who
  is this and how hot is it," not a full field dump.

### Actions row

```
[ Concluir ]   [ Abrir conversa ]   [ WhatsApp ]              [ ⋮ ]
```

- **Concluir** stays the single primary, most visually prominent action
  (`Button` default variant) — unchanged behavior
  (`POST /tasks/:id/complete`).
- **Abrir conversa** / **WhatsApp** stay secondary (`variant="outline"`),
  unchanged.
- **Reagendar** and **Cancelar** move into a small overflow menu (`⋮`,
  `ui/dropdown-menu.tsx`, already in the design system) instead of being
  loose buttons — this directly satisfies "Cancelar não pode ficar num
  clique acidental." Reagendar opens the existing `RescheduleDialog`
  unchanged; Cancelar keeps the existing `window.confirm()` guard and
  `POST /tasks/:id/cancel` call, just triggered from inside the menu item
  (styled with `text-destructive` to signal it's the risky one).
- These are the *only* two items in the menu — no restructuring beyond
  relocating the two already-existing handlers.

### Sections → accordion

Built on a new `apps/web/src/components/ui/accordion.tsx`, a thin wrapper
around `@base-ui/react/accordion` following the exact pattern
`ui/tabs.tsx` already uses (`data-slot` attributes, `cn()`, Tailwind
transitions) — no new UI library, no visual system invented from scratch.

- Open by default: **Resumo do atendimento**, **Informações comerciais**
  (the fields that matter for *every* deal type regardless of attendance
  type: `product_interest`, `product_model`, `sale_amount`,
  `down_payment_amount` — only meaningful outside consortium, same
  conditional the current `commercialFields()` already uses —
  `target_installment_amount`, `term_months`, `next_action`).
- Collapsed by default:
  - **Dados do cliente** — unchanged (`CLIENT_FIELDS`: attendance type,
    city, usage purpose, urgency).
  - **Financiamento** — unchanged, still only rendered when
    `attendance_type === "financing"` (CPF, birth date, driver's license).
  - **Consórcio** (new section, only rendered when
    `attendance_type === "consortium"`) — `credit_amount` and `bid_amount`,
    currently folded into the always-open "Informações comerciais"; moved
    here so the open section stays universal/short and consortium-specific
    numbers don't clutter it for financing/cash deals. Rendered as the same
    stat-block treatment described below.
  - **Observações** (new section) — `commercial_notes`, currently folded
    into "Informações comerciais"; split out so the open-by-default
    commercial section stays short.
- Each accordion header keeps the section title and gets the same pencil
  icon treatment as the panel header (`QualificationSection`'s text
  "Editar" button becomes an icon button) — same edit flow, same
  `handleSaveSection` → `PATCH /conversations/:id/qualification` call,
  same per-field change-only diff (`draftToPatch`) that preserves
  `human_locked_fields` semantics untouched.
- A collapsed section with real data still shows a one-line preview (e.g.
  "Dados do cliente" collapsed but showing the city or attendance type
  inline in the header trigger, muted-color) so nothing important is fully
  hidden — this is a display nicety, not a functional requirement, and can
  be dropped from the plan if it adds too much complexity for this pass.

### Resumo — executive-summary truncation

- The `summary` field's textarea display is capped visually at 3 lines
  (`line-clamp-3`) when not editing.
- If the stored text overflows 3 lines, a small "Mostrar mais" text button
  appears below it, expanding to the full text in place (local `useState`,
  no data refetch, no API change) with the button then reading "Mostrar
  menos".
- Editing (the pencil icon) always opens the full untruncated textarea,
  same as today.

### Commercial numbers — visual emphasis

Within "Informações comerciais" (and within "Consórcio" for its own
`credit_amount`/`bid_amount` pair), each currency/term field renders as a
small stat block in a 2-column grid instead of a label/value text row:

```
┌────────────────┐  ┌────────────────┐
│ R$ 60.000      │  │ R$ 35.000      │
│ Valor da venda │  │ Entrada        │
└────────────────┘  └────────────────┘
```

Value: `text-lg font-semibold` (or `text-xl` if it fits without wrapping).
Label: `text-xs text-muted-foreground` below it. Non-currency fields in the
same section (`product_interest`, `product_model`, `next_action`,
`term_months`) keep the existing compact label/value row style — only
money and the installment term get the stat-block treatment, since those
are what the user explicitly called out as needing to "chamar mais
atenção."

### Panel width

`Sheet`'s `sm:max-w-md` becomes `sm:max-w-lg` — needed for the 2-column
stat grid to breathe without cramping; still a side panel, not a takeover.

## State preservation (must not regress)

- `selectedTaskId` continues to live in `page.tsx`; the row highlight is
  purely `task.id === selectedTaskId` — no new source of truth introduced.
- Selection clears only when the panel's own close (`✕` / overlay click /
  `Concluir` succeeding) fires `onClose`/`onTaskChanged` — unchanged from
  today's behavior, just re-verified as part of this pass since the list
  row rendering is being rewritten.
- `tab` (bucket filter) and the list's scroll position are untouched by
  opening/closing the panel today (they're sibling state, not remounted) —
  the redesign keeps `TaskList`/`TaskCard` as the same component identities
  (same `key={task.id}`) so React doesn't remount rows and reset scroll
  when `selectedTaskId` changes.

## Explicitly out of scope for this pass

- Any backend change of any kind (see Non-goals).
- Virtualizing the list (not needed at current task volumes; revisit if a
  future org routinely has hundreds of open tasks).
- The collapsed-section one-line preview is a nice-to-have, not required —
  the plan may cut it if it meaningfully complicates the accordion wrapper.

## Testing approach

- `formatRelativeTime`: unit tests for the min/hour/day/fallback boundaries.
- Existing `packages/shared` task-helper tests (`isHotLead`,
  `sortTasksForToday`, `resolveTaskBucket`) are untouched and must stay
  green — this pass doesn't change what they compute, only how the result
  is displayed.
- Manual verification in the browser (per this project's convention for
  frontend-only changes): compact list renders correctly across all 4
  buckets, selection highlight persists and clears correctly, accordion
  default-open/closed states match spec, "Mostrar mais" expands/collapses,
  Reagendar/Cancelar/Editar-tarefa all still call the same endpoints and
  produce the same effects as before the redesign, panel width change
  doesn't break small viewports.
