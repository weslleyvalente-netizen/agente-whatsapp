# Tasks Panel & List — Compact Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the task detail panel show only populated qualification fields
in view mode, and turn the task list rows into a true compact-inbox layout
with dividers instead of per-row cards.

**Architecture:** Two independent front-end-only changes on top of the
already-shipped Tasks Inbox UX (`specs/2026-08-05-tasks-inbox-ux-design.md`).
Part 1 touches `qualification-section.tsx` (generic filtering logic) and
`task-detail-panel.tsx` (wiring: which sections render, two new always-visible
blocks). Part 2 touches `task-card.tsx` (row layout) and `task-list.tsx`
(container: dividers instead of cards). No new components, no new dependencies.

**Tech Stack:** Next.js App Router, React, Tailwind v4, existing
`QualificationSection`/`Accordion` components — no additions.

## Global Constraints

- Spec: `specs/2026-08-06-tasks-panel-list-compact-design.md`. Read it before
  starting if anything below is ambiguous.
- Do NOT touch `packages/database`, `supabase/migrations`, `apps/api`,
  `apps/worker`, or any Helena tool/prompt. Every task's file list is
  restricted to `apps/web/src/components/tasks/*` and, only if strictly
  needed, `apps/web/src/lib/utils.ts` (this plan does not end up needing
  `utils.ts` changes — `formatCurrencyBRL`/`formatRelativeTime` already exist
  and are reused as-is).
- Do NOT change `draftToPatch`, `handleSaveSection`, `human_locked_fields`
  semantics, or any PATCH/API call shape. This plan only changes what is
  rendered in read mode and how list rows are laid out — never what gets
  saved or how.
- No test runner exists in `apps/web` (no vitest/jest, no `test` script) —
  this is a confirmed project-wide fact, not something to fix here.
  Verification per task is `pnpm --filter web typecheck` plus live
  browser testing (dev server or, for the final task, production/staging as
  directed by the human partner). Do not attempt to add a test framework.
- "Não informado" must never appear in view mode after this plan — every
  field either shows its real value or is not rendered at all.
- Fields with no backing database column (lance próprio/embutido split,
  orçamento, forma de pagamento, veículo/problema relatado estruturados,
  the synthesized "Estratégia" string) are explicitly out of scope — do not
  invent new fields or columns to cover them.

---

### Task 1: `QualificationSection` — hide empty fields, add `hideInView` and `emptyFallback`

**Files:**
- Modify: `apps/web/src/components/tasks/qualification-section.tsx`

**Interfaces:**
- Produces: `export function hasValue(value: unknown): boolean` — true when
  `value !== null && value !== undefined && value !== ""`.
- Produces: `export function sectionHasContent(fields: QualificationFieldDescriptor[], values: Record<string, unknown>): boolean`
  — `fields.some((f) => hasValue(values[f.key]))`. Tasks 2 and 3 call this
  with a `Record<string, unknown>` built from the qualification object.
- Produces: `export function formatReadValue(...)` — same signature and
  behavior as today, just now exported instead of module-private.
- Produces: `QualificationFieldDescriptor` — every union member gains an
  optional `hideInView?: boolean`. A field with `hideInView: true` is skipped
  in the read-mode list (both the emphasized grid and the plain list) but
  still appears in the edit-mode form exactly as before.
- Produces: `QualificationSectionProps` gains an optional
  `emptyFallback?: string`. When the section has zero visible fields (after
  filtering by `hasValue` and `hideInView`) and `emptyFallback` is set, that
  text renders instead of nothing. When `emptyFallback` is not set and there
  is nothing to show, the section renders an empty (but valid) container —
  callers are expected to not render `QualificationSection` at all in that
  case (Task 2 does this via `sectionHasContent`), except for the Resumo
  section which always passes `emptyFallback`.
- Consumes: nothing from other tasks — this is the foundational task.

- [ ] **Step 1: Add `hasValue`, `sectionHasContent`, and export `formatReadValue`**

Replace the current private `formatReadValue` function and the top of the
file with:

```tsx
export type QualificationFieldDescriptor =
  | { key: string; label: string; kind: "text"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "textarea"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "number"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "currency"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "date"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "boolean"; emphasize?: boolean; hideInView?: boolean }
  | {
      key: string;
      label: string;
      kind: "select";
      options: Array<{ value: string; label: string }>;
      emphasize?: boolean;
      hideInView?: boolean;
    };

export function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

export function sectionHasContent(fields: QualificationFieldDescriptor[], values: Record<string, unknown>): boolean {
  return fields.some((f) => hasValue(values[f.key]));
}

export function formatReadValue(field: QualificationFieldDescriptor, value: unknown): string | null {
  if (!hasValue(value)) return null;
  if (field.kind === "currency") return formatCurrencyBRL(value as number);
  if (field.kind === "boolean") return value === true ? "Sim" : "Não";
  if (field.kind === "date") return new Date(`${value}T00:00:00`).toLocaleDateString("pt-BR");
  if (field.kind === "select") return field.options.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}
```

This replaces the existing `QualificationFieldDescriptor` type and
`formatReadValue` function in place — do not duplicate them.

- [ ] **Step 2: Add `emptyFallback` to `QualificationSectionProps`**

```tsx
interface QualificationSectionProps {
  title: string;
  fields: QualificationFieldDescriptor[];
  values: Record<string, unknown>;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  truncateSummary?: boolean;
  hideTitle?: boolean;
  emptyFallback?: string;
}
```

Update the component signature to destructure it:

```tsx
export function QualificationSection({
  title,
  fields,
  values,
  onSave,
  truncateSummary = false,
  hideTitle = false,
  emptyFallback,
}: QualificationSectionProps) {
```

- [ ] **Step 3: Rewrite the read-mode rendering block to filter out empty and `hideInView` fields**

Replace the entire `{!editing ? ( ... ) : (` read-mode branch (the first
branch of the ternary, currently rendering the emphasized grid and the plain
field list with `"Não informado"` fallbacks) with:

```tsx
      {!editing ? (
        <div className="space-y-3">
          {(() => {
            const visibleFields = fields.filter((f) => !f.hideInView && hasValue(values[f.key]));
            if (visibleFields.length === 0) {
              return emptyFallback ? <p className="text-sm text-muted-foreground italic">{emptyFallback}</p> : null;
            }
            const emphasized = visibleFields.filter((f) => f.emphasize);
            const regular = visibleFields.filter((f) => !f.emphasize);
            return (
              <>
                {emphasized.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {emphasized.map((f) => (
                      <div key={f.key} className="rounded-md border bg-muted/30 p-2">
                        <p className="text-lg font-semibold">{formatReadValue(f, values[f.key])}</p>
                        <p className="text-xs text-muted-foreground">{f.label}</p>
                      </div>
                    ))}
                  </div>
                )}
                {regular.length > 0 && (
                  <div>
                    {regular.map((f) => {
                      const display = formatReadValue(f, values[f.key]);
                      if (truncateSummary && f.kind === "textarea" && display) {
                        return <TruncatedText key={f.key} text={display} />;
                      }
                      return (
                        <div key={f.key} className="flex items-center justify-between gap-4 py-1 text-sm">
                          <span className="text-muted-foreground">{f.label}</span>
                          <span className="font-medium">{display}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ) : (
```

Do not change anything inside the `editing` branch (the form) — it must keep
iterating over the full `fields` array, unfiltered, exactly as it does today.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors. This task has no independently visible behavior yet
(nothing calls `QualificationSection` with a real `hideInView` field or
`emptyFallback` until Task 2) — typecheck is the only verification available
at this stage, consistent with how the accordion primitive was verified in
the previous plan before it was wired in.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tasks/qualification-section.tsx
git commit -m "feat(web): hide unfilled qualification fields in view mode"
```

---

### Task 2: Panel — Resumo becomes always-visible, empty sections disappear

**Files:**
- Modify: `apps/web/src/components/tasks/task-detail-panel.tsx`

**Interfaces:**
- Consumes: `sectionHasContent` and the `hideInView` field from Task 1.
- Produces: `commercialFields(attendanceType)` now marks its `next_action`
  entry with `hideInView: true`. Task 3 relies on `next_action` no longer
  appearing in "Informações comerciais"'s read-mode list.
- Produces: the `<Accordion>` in the panel body now only ever contains
  `AccordionItem`s for sections that have content — `AccordionItem value="comercial"`,
  `value="cliente"`, `value="financiamento"`, `value="consorcio"`,
  `value="observacoes"` are all conditionally rendered. `value="resumo"` no
  longer exists (Resumo is rendered before the `Accordion`, not inside it).
  Task 3 inserts new JSX inside the `value="comercial"` `AccordionContent`
  and after the closing `</Accordion>` tag — both anchors this task creates.

- [ ] **Step 1: Import `sectionHasContent`**

Change:

```tsx
import { QualificationSection, type QualificationFieldDescriptor } from "./qualification-section";
```

to:

```tsx
import { QualificationSection, sectionHasContent, type QualificationFieldDescriptor } from "./qualification-section";
```

- [ ] **Step 2: Mark `next_action` as `hideInView` in `commercialFields`**

In the existing `commercialFields` function, change the last entry:

```tsx
    { key: "next_action", label: "Próxima ação", kind: "text" },
```

to:

```tsx
    { key: "next_action", label: "Próxima ação", kind: "text", hideInView: true },
```

- [ ] **Step 3: Extract Resumo out of the accordion, gate every other section on `sectionHasContent`**

Replace the entire `<Accordion defaultValue={["resumo", "comercial"]}>...</Accordion>`
block (the whole accordion, all 6 `AccordionItem`s) with:

```tsx
            <QualificationSection
              title="Resumo do atendimento"
              fields={SUMMARY_FIELDS}
              values={qualification as unknown as Record<string, unknown>}
              onSave={handleSaveSection}
              truncateSummary
              hideTitle
              emptyFallback="Nenhum resumo disponível ainda."
            />

            <Accordion defaultValue={["comercial"]}>
              {sectionHasContent(
                commercialFields(attendanceType).filter((f) => !f.hideInView),
                qualification as unknown as Record<string, unknown>
              ) && (
                <AccordionItem value="comercial">
                  <AccordionTrigger>Informações comerciais</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Informações comerciais"
                      fields={commercialFields(attendanceType)}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                    />
                  </AccordionContent>
                </AccordionItem>
              )}

              {sectionHasContent(CLIENT_FIELDS, qualification as unknown as Record<string, unknown>) && (
                <AccordionItem value="cliente">
                  <AccordionTrigger>Dados do cliente</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Dados do cliente"
                      fields={CLIENT_FIELDS}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                    />
                    {details.conversation && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Última interação: {new Date(details.conversation.lastMessageAt).toLocaleString("pt-BR")}
                      </p>
                    )}
                  </AccordionContent>
                </AccordionItem>
              )}

              {attendanceType === "financing" &&
                sectionHasContent(FINANCING_FIELDS, qualification as unknown as Record<string, unknown>) && (
                  <AccordionItem value="financiamento">
                    <AccordionTrigger>Financiamento</AccordionTrigger>
                    <AccordionContent>
                      <QualificationSection
                        title="Financiamento"
                        fields={FINANCING_FIELDS}
                        values={qualification as unknown as Record<string, unknown>}
                        onSave={handleSaveSection}
                        hideTitle
                      />
                    </AccordionContent>
                  </AccordionItem>
                )}

              {attendanceType === "consortium" &&
                sectionHasContent(CONSORTIUM_FIELDS, qualification as unknown as Record<string, unknown>) && (
                  <AccordionItem value="consorcio">
                    <AccordionTrigger>Consórcio</AccordionTrigger>
                    <AccordionContent>
                      <QualificationSection
                        title="Consórcio"
                        fields={CONSORTIUM_FIELDS}
                        values={qualification as unknown as Record<string, unknown>}
                        onSave={handleSaveSection}
                        hideTitle
                      />
                    </AccordionContent>
                  </AccordionItem>
                )}

              {sectionHasContent(OBSERVATION_FIELDS, qualification as unknown as Record<string, unknown>) && (
                <AccordionItem value="observacoes">
                  <AccordionTrigger>Observações</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Observações"
                      fields={OBSERVATION_FIELDS}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                    />
                  </AccordionContent>
                </AccordionItem>
              )}
            </Accordion>
```

Note `commercialFields(attendanceType)` is called twice (once filtered for
the `sectionHasContent` check, once unfiltered for the actual field list
passed to `QualificationSection`) — this matches the existing codebase style
where the function is a plain field-list builder with no memoization, and
keeps the `sectionHasContent` call and the render call independently
readable.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 5: Live verification**

Start the dev server (`pnpm --filter web dev`) and, using the cookie-transfer
login technique (or any already-authenticated session), open the Tasks
screen and inspect at least two real tasks in the panel:

1. A task with `attendance_type: null` and no qualification data at all —
   confirm only "Resumo do atendimento" renders (with the fallback text if
   `summary` is null), and no accordion sections appear at all.
2. A task with some qualification fields set — confirm every section that
   has at least one populated field renders, every section with zero
   populated fields is entirely absent (no empty accordion trigger visible),
   and no field row anywhere shows "Não informado".

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/tasks/task-detail-panel.tsx
git commit -m "feat(web): hide empty panel sections, promote Resumo out of the accordion"
```

---

### Task 3: Panel — "Valor a financiar" computed block and "Próxima ação" standalone block

**Files:**
- Modify: `apps/web/src/components/tasks/task-detail-panel.tsx`

**Interfaces:**
- Consumes: the `value="comercial"` `AccordionItem` and the `</Accordion>`
  closing tag from Task 2 — both exist in the file after Task 2 lands.
- Produces: nothing new consumed by later tasks (Tasks 4-5 touch different
  files entirely).

- [ ] **Step 1: Import `formatCurrencyBRL`**

Change:

```tsx
import { formatPhone, formatRelativeTime } from "@/lib/utils";
```

to:

```tsx
import { formatCurrencyBRL, formatPhone, formatRelativeTime } from "@/lib/utils";
```

- [ ] **Step 2: Add the "Valor a financiar" computed block inside "Informações comerciais"**

Inside the `value="comercial"` `AccordionItem`'s `AccordionContent`, right
after the `<QualificationSection .../>` call (and still inside
`AccordionContent`, before its closing tag), add:

```tsx
                    {attendanceType === "financing" &&
                      qualification.sale_amount != null &&
                      qualification.down_payment_amount != null && (
                        <div className="mt-2 rounded-md border bg-muted/30 p-2">
                          <p className="text-lg font-semibold">
                            {formatCurrencyBRL(qualification.sale_amount - qualification.down_payment_amount)}
                          </p>
                          <p className="text-xs text-muted-foreground">Valor a financiar</p>
                        </div>
                      )}
```

So the full `AccordionContent` for `value="comercial"` becomes:

```tsx
                  <AccordionContent>
                    <QualificationSection
                      title="Informações comerciais"
                      fields={commercialFields(attendanceType)}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                    />
                    {attendanceType === "financing" &&
                      qualification.sale_amount != null &&
                      qualification.down_payment_amount != null && (
                        <div className="mt-2 rounded-md border bg-muted/30 p-2">
                          <p className="text-lg font-semibold">
                            {formatCurrencyBRL(qualification.sale_amount - qualification.down_payment_amount)}
                          </p>
                          <p className="text-xs text-muted-foreground">Valor a financiar</p>
                        </div>
                      )}
                  </AccordionContent>
```

This value is computed at render time only — it is never sent to the API and
never appears in the edit-mode form (it is not a `QualificationFieldDescriptor`,
just a hand-written JSX block).

- [ ] **Step 3: Add the "Próxima ação" standalone block after the accordion**

Immediately after the `</Accordion>` closing tag (still inside the
`{details && !loading && !error && (<div className="space-y-4 p-4">...` wrapper,
as the last child before that wrapper's closing `</div>`), add:

```tsx

            {qualification.next_action && (
              <div className="rounded-md border bg-muted/30 p-2">
                <p className="text-xs text-muted-foreground">Próxima ação</p>
                <p className="text-sm font-medium">{qualification.next_action}</p>
              </div>
            )}
```

This block is always visible (not inside any `AccordionItem`) whenever
`next_action` has a value, regardless of which other sections are present or
absent. It is read-only here — editing `next_action` still happens through
the "Informações comerciais" section's edit form, where the field remains
present (marked `hideInView: true` from Task 2, which only affects the
read-mode list, not the edit form).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 5: Live verification**

Using the dev server:

1. Find or temporarily set (then revert) a task with `attendance_type: financing`,
   `sale_amount` and `down_payment_amount` both set — confirm "Valor a
   financiar" appears inside "Informações comerciais" with the correct
   subtraction, formatted as currency.
2. Confirm a task with `attendance_type: financing` but only one of
   `sale_amount`/`down_payment_amount` set does NOT show "Valor a financiar".
3. Confirm a task with `next_action` set shows the "Próxima ação" block, and
   that it remains visible when "Informações comerciais" is collapsed
   (scroll/collapse the accordion, confirm "Próxima ação" doesn't disappear).
4. Confirm a task with `next_action` null shows no "Próxima ação" block.
5. Open "Informações comerciais" for edit — confirm "Próxima ação" is still
   present as an editable field in the form, and that saving a new value
   updates the standalone block after save (same `onTaskChanged`/`fetchDetails`
   refresh flow as every other field — no change to that flow in this task).

If step 1 requires editing a real production/staging task's data to test,
follow the same safe pattern used earlier in this project: set the values
through the actual save flow, verify, then revert to their original values
and confirm the revert through the qualification event history — never leave
test data behind in a real task.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/tasks/task-detail-panel.tsx
git commit -m "feat(web): show computed Valor a financiar and a standalone Próxima ação block"
```

---

### Task 4: Task list row — compact layout, no per-row card

**Files:**
- Modify: `apps/web/src/components/tasks/task-card.tsx`

**Interfaces:**
- Produces: `TaskCard`'s outer `<div>` no longer has `rounded-md border` —
  Task 5's container div is what now provides the visual border/rounding
  around the whole list. Task 5 must wrap `TaskCard` instances in a container
  that supplies that border, or rows will render with no visible boundary at
  all.
- Consumes: nothing new — `TaskCardProps`, `assigneeLabel`, `dueLabel` are
  unchanged from today.

- [ ] **Step 1: Rewrite the row JSX**

Replace the whole `return (...)` block inside `TaskCard` with:

```tsx
  return (
    <div
      className={cn(
        "relative cursor-pointer space-y-0.5 px-3 py-2 transition-colors",
        isSelected ? "bg-accent/40" : "hover:bg-accent/30"
      )}
      onClick={() => onOpenDetails(task.id)}
    >
      {isSelected && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="min-w-0 truncate text-sm font-medium">
          {task.wa_contacts?.name || formatPhone(task.wa_contacts?.phone) || "Cliente"}
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">{TASK_TYPE_LABELS[task.type]}</span>
          {hot && (
            <Badge variant="tonal">
              <Flame className="size-3" />
              Quente
            </Badge>
          )}
          <Badge variant="secondary">{TASK_PRIORITY_LABELS[task.priority]}</Badge>
          <Badge variant="outline">{TASK_STATUS_LABELS[task.status]}</Badge>
        </div>
      </div>
      <p className="line-clamp-2 text-sm">{task.description}</p>
      <p className="text-xs text-muted-foreground">
        {assigneeLabel(task, memberEmailsById)} · {dueLabel(task)} · {formatRelativeTime(task.conversations?.last_message_at)}
      </p>
    </div>
  );
```

Changes from the current version: `rounded-md border p-3` → `px-3 py-2` (no
border, no rounding — the row is flat); the name row gains `flex-wrap` and
`gap-x-2 gap-y-1` so badges wrap under the name on narrow screens instead of
overflowing; the badges cluster gains `flex-wrap`; `TASK_TYPE_LABELS[task.type]`
moves from its own paragraph into that badges cluster as small muted text,
first in the row; the selection bar changes from `inset-y-1 ... rounded-full`
to `inset-y-0` (full row height, no rounding, since the row itself has no
rounded corners to match anymore).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tasks/task-card.tsx
git commit -m "feat(web): compact task row layout, drop per-row card styling"
```

---

### Task 5: Task list container — dividers instead of stacked cards

**Files:**
- Modify: `apps/web/src/components/tasks/task-list.tsx`

**Interfaces:**
- Consumes: `TaskCard` from Task 4 (now borderless, expects its container to
  supply the visual boundary).

- [ ] **Step 1: Replace every `space-y-2` row-list wrapper with a `divide-y` container**

There are three places in the file where `TaskCard`s are mapped inside a
`<div className="space-y-2">`: the `bucket !== "today"` flat list, the "hot"
group, and the "warm" group. Replace all three wrapper `className`s from
`"space-y-2"` to `"divide-y overflow-hidden rounded-md border"`.

The `bucket !== "today"` branch becomes:

```tsx
  if (bucket !== "today") {
    return (
      <div className="divide-y overflow-hidden rounded-md border">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            memberEmailsById={memberEmailsById}
            isSelected={task.id === selectedTaskId}
            onOpenDetails={onOpenDetails}
          />
        ))}
      </div>
    );
  }
```

The "today" bucket's grouped return becomes:

```tsx
  return (
    <div className="space-y-6">
      {hot.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">🔥 Leads quentes</h3>
          <div className="divide-y overflow-hidden rounded-md border">
            {hot.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                memberEmailsById={memberEmailsById}
                isSelected={task.id === selectedTaskId}
                onOpenDetails={onOpenDetails}
              />
            ))}
          </div>
        </div>
      )}
      {warm.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">🟡 Follow-ups</h3>
          <div className="divide-y overflow-hidden rounded-md border">
            {warm.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                memberEmailsById={memberEmailsById}
                isSelected={task.id === selectedTaskId}
                onOpenDetails={onOpenDetails}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
```

The outer `<div className="space-y-2">` that wraps the `<h3>` heading plus
the new divider box stays — that spacing is between the heading and the box,
not between rows, and is unrelated to the per-row card removal.

`overflow-hidden` clips each row's selected/hover background color to the
container's rounded corners — without it, a selected first or last row would
paint a square-cornered highlight past the container's `rounded-md` corners.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 3: Live verification**

Using the dev server, open the Tasks screen on the "Hoje" tab (grouped) and
on "Atrasadas" (flat list). Confirm: a single bordered/rounded box contains
all rows in each group, thin horizontal dividers separate rows (no gaps, no
per-row borders), selecting a row shows the accent background + left bar
clipped cleanly to the box's rounded corners even when the selected row is
first or last, and hovering a non-selected row shows the subtle hover
background without any card-like shadow or border appearing.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tasks/task-list.tsx
git commit -m "feat(web): replace stacked task cards with a single divided list"
```

---

### Task 6: Panel — entry point to add data when qualification is fully empty

**Context:** discovered during final validation, not in the original spec.
Once "Informações comerciais" and "Dados do cliente" only render when they
already have content (Task 2), a task whose `conversation_qualifications`
row is entirely null loses every way to reach those sections' edit forms —
their pencil icons live inside `AccordionContent`, which never mounts when
`sectionHasContent` is false. `task-dialog.tsx` (the "Editar tarefa" pencil
in the panel header) only edits task metadata (priority, due date, assignee,
etc.) — it has no qualification fields at all. Confirmed live against real
production-mirrored data: at least two real tasks in the current dataset
have zero qualification and, before this task, offer no way to manually add
commercial/client data through the panel. Human-approved fix: a single
"+ Adicionar informações" entry point, shown only when none of the 5
accordion sections would otherwise render, that opens "Informações
comerciais" and "Dados do cliente" together in edit mode. Financiamento and
Consórcio are intentionally NOT covered by this fix — they stay gated on
`attendanceType`, which the vendor sets via this same "Dados do cliente"
form; once saved, a refetch naturally reveals whichever type-specific
section becomes applicable. Observações is not covered either — it is a
free-text notes field, not required to unblock the core workflow.

**Files:**
- Modify: `apps/web/src/components/tasks/qualification-section.tsx`
- Modify: `apps/web/src/components/tasks/task-detail-panel.tsx`

**Interfaces:**
- Produces: `QualificationSectionProps` gains an optional
  `startInEditMode?: boolean` (default `false`). When `true`, the component
  mounts already in edit mode with the draft pre-populated from `values`
  (same shape `startEditing()` already builds) — the vendor sees the edit
  form immediately, no pencil click needed. When `false` (or omitted),
  behavior is 100% unchanged from Task 1/2/3's final state.
- Consumes: `sectionHasContent` (Task 1), `commercialFields`/`CLIENT_FIELDS`
  (existing, from Task 2's final state).

- [ ] **Step 1: Add `startInEditMode` to `QualificationSection`**

In `apps/web/src/components/tasks/qualification-section.tsx`, add the prop
to the interface:

```tsx
interface QualificationSectionProps {
  title: string;
  fields: QualificationFieldDescriptor[];
  values: Record<string, unknown>;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  truncateSummary?: boolean;
  hideTitle?: boolean;
  emptyFallback?: string;
  startInEditMode?: boolean;
}
```

Destructure it with a default and use it to initialize both `editing` and
`draft`, replacing the current `useState(false)` / `useState({})` calls:

```tsx
export function QualificationSection({
  title,
  fields,
  values,
  onSave,
  truncateSummary = false,
  hideTitle = false,
  emptyFallback,
  startInEditMode = false,
}: QualificationSectionProps) {
  const [editing, setEditing] = useState(startInEditMode);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    if (!startInEditMode) return {};
    const initial: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key];
      initial[f.key] = v === null || v === undefined ? "" : String(v);
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
```

Do not change `startEditing` itself (still used by the pencil-click path for
the normal, already-has-content case) or anything else in the component.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors. `startInEditMode` has no callers yet — Step 3 adds them.

- [ ] **Step 3: Wire the "+ Adicionar informações" entry point in the panel**

In `apps/web/src/components/tasks/task-detail-panel.tsx`, add local state
right after the existing `useState`/`useCallback` declarations inside
`TaskDetailPanel`:

```tsx
  const [forceShowGeneric, setForceShowGeneric] = useState(false);
```

(Add `useState` to the existing `"react"` import if not already destructured
— check the current import line first; `useState` is already imported per
Task 1-5's code, so this is likely already available.)

Compute whether any of the 5 accordion sections would render, right before
the `return (` statement (reuse the exact same conditions the Accordion
already evaluates):

```tsx
  const hasAnyQualificationSection =
    sectionHasContent(
      commercialFields(attendanceType).filter((f) => !f.hideInView),
      qualification as unknown as Record<string, unknown>
    ) ||
    sectionHasContent(CLIENT_FIELDS, qualification as unknown as Record<string, unknown>) ||
    (attendanceType === "financing" &&
      sectionHasContent(FINANCING_FIELDS, qualification as unknown as Record<string, unknown>)) ||
    (attendanceType === "consortium" &&
      sectionHasContent(CONSORTIUM_FIELDS, qualification as unknown as Record<string, unknown>)) ||
    sectionHasContent(OBSERVATION_FIELDS, qualification as unknown as Record<string, unknown>);
```

Insert the button between the Resumo `QualificationSection` and the
`Accordion`:

```tsx
            <QualificationSection
              title="Resumo do atendimento"
              fields={SUMMARY_FIELDS}
              values={qualification as unknown as Record<string, unknown>}
              onSave={handleSaveSection}
              truncateSummary
              hideTitle
              emptyFallback="Nenhum resumo disponível ainda."
            />

            {!hasAnyQualificationSection && !forceShowGeneric && (
              <button
                type="button"
                className="text-sm font-medium text-primary hover:underline"
                onClick={() => setForceShowGeneric(true)}
              >
                + Adicionar informações
              </button>
            )}

            <Accordion key={forceShowGeneric ? "forced" : "default"} defaultValue={forceShowGeneric ? ["comercial", "cliente"] : ["comercial"]}>
              {(forceShowGeneric ||
                sectionHasContent(
                  commercialFields(attendanceType).filter((f) => !f.hideInView),
                  qualification as unknown as Record<string, unknown>
                )) && (
                <AccordionItem value="comercial">
                  <AccordionTrigger>Informações comerciais</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Informações comerciais"
                      fields={commercialFields(attendanceType)}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                      startInEditMode={forceShowGeneric}
                    />
                    {attendanceType === "financing" &&
                      qualification.sale_amount != null &&
                      qualification.down_payment_amount != null && (
                        <div className="mt-2 rounded-md border bg-muted/30 p-2">
                          <p className="text-lg font-semibold">
                            {formatCurrencyBRL(qualification.sale_amount - qualification.down_payment_amount)}
                          </p>
                          <p className="text-xs text-muted-foreground">Valor a financiar</p>
                        </div>
                      )}
                  </AccordionContent>
                </AccordionItem>
              )}

              {(forceShowGeneric ||
                sectionHasContent(CLIENT_FIELDS, qualification as unknown as Record<string, unknown>)) && (
                <AccordionItem value="cliente">
                  <AccordionTrigger>Dados do cliente</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Dados do cliente"
                      fields={CLIENT_FIELDS}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                      startInEditMode={forceShowGeneric}
                    />
                    {details.conversation && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Última interação: {new Date(details.conversation.lastMessageAt).toLocaleString("pt-BR")}
                      </p>
                    )}
                  </AccordionContent>
                </AccordionItem>
              )}
```

The remaining three `AccordionItem`s (`financiamento`, `consorcio`,
`observacoes`) are unchanged from Task 2/3's final state — do not modify
them, do not add `forceShowGeneric` to their gates. Everything after the
`cliente` AccordionItem (financiamento/consorcio/observacoes, the closing
`</Accordion>`, and the "Próxima ação" block) stays exactly as Task 3 left
it.

The `key={forceShowGeneric ? "forced" : "default"}` on `<Accordion>` is
required — Base UI's Accordion `defaultValue` is read once on mount
(uncontrolled), so changing `defaultValue` alone after the initial render
would not re-open "cliente". The `key` change forces React to remount the
Accordion with the new `defaultValue` the moment the button is clicked.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 5: Live verification**

Using the dev server:

1. Open a real (or temporarily-blanked-then-reverted) task with a fully
   empty `conversation_qualifications` row — confirm "+ Adicionar
   informações" appears below the Resumo fallback text, and nothing else.
2. Click it — confirm "Informações comerciais" and "Dados do cliente" both
   appear, both expanded, both already in their edit form (not read mode) —
   no extra pencil click needed. Confirm the "+ Adicionar informações"
   button itself disappears once clicked.
3. Set `attendance_type` to `financing` (or `consortium`) and save — confirm
   the save succeeds through the normal `handleSaveSection`/PATCH flow (no
   change to that flow), and after the refetch, the newly-relevant
   type-specific section (Financiamento/Consórcio) becomes reachable the
   next time it has content, exactly as for any other task.
4. Revert whatever was set back to null through the same edit form, confirm
   via a fresh page load (not just client state) that the task returns to
   showing only the Resumo fallback + the "+ Adicionar informações" button,
   with no leftover data.
5. Confirm, on a task that already has SOME qualification data (any of the
   existing test tasks from Tasks 2/3), that "+ Adicionar informações" does
   NOT appear — this fix must not resurface on tasks that already work.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/tasks/qualification-section.tsx apps/web/src/components/tasks/task-detail-panel.tsx
git commit -m "feat(web): add an entry point to add data when qualification is fully empty"
```

---

### Task 7: Fix badge cluster overflow on narrow viewports

**Context:** discovered during final validation, live at 375px width. The
name/badges row in `task-card.tsx` (`<div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">`)
wraps its two direct children (the name `<p>` and the badges cluster `<div>`)
correctly, but the badges cluster itself — `<div className="flex shrink-0 flex-wrap items-center gap-1">`
holding the type label + Quente + priority + status badges — has no maximum
width of its own. A flex item with `flex-wrap` but no width constraint sizes
itself to fit all its children on one line before ever wrapping internally,
so on a task with all 4 items (type label, "Quente", priority, status), the
cluster renders wider than the row itself and overflows/gets clipped instead
of wrapping to a second line. Confirmed live: at 375px, a hot-lead task's
badge cluster measured 347px wide inside a 237px-wide row. Confirmed live
that adding `flex-basis: 100%` to the cluster (so it claims the full row
width once it wraps below the name, giving its own internal `flex-wrap`
something to wrap against) fixes it — the cluster's own items then wrap
correctly (type + "Quente" on one line, priority + status on the next) and
stay within the row's width.

**Files:**
- Modify: `apps/web/src/components/tasks/task-card.tsx`

- [ ] **Step 1: Add `basis-full` to the badges cluster**

Change:

```tsx
        <div className="flex shrink-0 flex-wrap items-center gap-1">
```

to:

```tsx
        <div className="flex shrink-0 flex-wrap basis-full items-center gap-1 sm:basis-auto">
```

`basis-full` (Tailwind: `flex-basis: 100%`) gives the cluster a real width to
wrap against once it drops below the name, fixing the overflow. `sm:basis-auto`
reverts to the natural (content-sized) width at `sm` and above (≥640px),
where Task 4/5's live-verified desktop/tablet layout (768px, 1280px) already
renders correctly on one line with room to spare — this change is scoped to
narrow viewports only, it must not alter anything at ≥640px.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors (this is a className-only change, typecheck is a
formality here but still required per this plan's verification standard).

- [ ] **Step 3: Live verification**

Using the dev server, resize to 375px and open a task whose row has all 4
badge-cluster items populated (type label + "Quente" + priority + status —
e.g. any hot-lead task). Confirm the badges cluster now wraps within the
row's width with no clipped/overflowing text, confirm the name is not
truncated more aggressively than before, and confirm nothing changed at
768px and 1280px (re-check both, since this is exactly the kind of change
that can silently regress a breakpoint that already worked).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tasks/task-card.tsx
git commit -m "fix(web): wrap the badge cluster within the row on narrow viewports"
```

---

### Task 8: Final validation — all scenarios, before/after comparison

**Files:** none (verification only, no code changes expected; if verification
surfaces a real defect, fix it in the file it belongs to and note the fix
here before re-verifying).

- [ ] **Step 1: Run the full typecheck one more time on the final state**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 2: Panel scenarios — verify live against real or deliberately-crafted qualification data**

Using the dev server (or production, if directed), find or temporarily set
(then revert, confirming the revert via the qualification event history)
tasks covering each of:

1. Financiamento com poucos campos preenchidos (e.g. only `cpf` and
   `birth_date`) — confirm only those two rows show inside "Financiamento",
   "Informações comerciais" is absent if none of its own fields are set, no
   "Não informado" anywhere.
2. Financiamento completo (all financing + commercial fields set) — confirm
   every populated field shows, "Valor a financiar" is computed correctly,
   "Próxima ação" shows if `next_action` is set.
3. Consórcio sem lance (`credit_amount` set, `bid_amount` null) — confirm
   "Consórcio" shows only "Crédito desejado".
4. Consórcio com lance (`credit_amount` and `bid_amount` both set) — confirm
   both show.
5. Tarefa apenas com resumo (`summary` set, everything else null) — confirm
   only the Resumo block renders, no accordion sections appear at all.
6. Tarefa sem qualificação nenhuma (`EMPTY_QUALIFICATION` — a task with no
   `conversation_qualifications` row, or one where every column is null) —
   confirm Resumo shows "Nenhum resumo disponível ainda.", the "+ Adicionar
   informações" button (Task 6) appears and works, and nothing else renders
   below the Resumo/button.

- [ ] **Step 3: List scenarios**

1. Visual comparison: screenshot the Tasks list before this plan (if still
   accessible via the previous production deploy or git history) and after,
   side by side — confirm row height is visibly closer to 64-80px, dividers
   replace per-row cards, and the selection highlight covers the full row
   height cleanly.
2. Responsiveness: resize to a narrow viewport (~375px) and confirm name +
   badges wrap without ever producing a button column, and the description
   stays clamped to 2 lines.

- [ ] **Step 4: Report**

Summarize, for the human partner: which scenarios were verified against real
data vs. deliberately-set-then-reverted data, any deviation found from the
spec (and whether it was fixed in this task or is a residual/known gap), and
a short before/after description (or screenshots) of both the panel and the
list.
