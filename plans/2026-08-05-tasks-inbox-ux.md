# Tasks Inbox UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Tarefas screen's presentation layer into a compact,
scannable CRM-inbox list with a dense, accordion-based side panel as the
real work surface — pure UI/UX, zero backend change.

**Architecture:** Every task touches only `apps/web` — component rewrites
inside `apps/web/src/components/tasks/`, one new design-system primitive
(`apps/web/src/components/ui/accordion.tsx`), and one new pure formatting
helper in `apps/web/src/lib/utils.ts`. All existing API calls
(`GET /tasks/:id/details`, `PATCH /conversations/:id/qualification`,
`POST /tasks/:id/complete`, `POST /tasks/:id/reschedule`,
`POST /tasks/:id/cancel`, the `TaskDialog` PATCH) are reused unchanged —
only which component triggers them moves.

**Tech Stack:** Next.js (App Router), React, Tailwind v4, `@base-ui/react`
(already a dependency; this plan is the first user of its `accordion` and
second user — after `dropdown-menu.tsx` — of its `menu` module),
`lucide-react` icons, TypeScript. No test runner exists in `apps/web`
today (confirmed: no `test` script, no vitest/jest dependency) — this plan
does not introduce one; verification is manual browser testing, consistent
with every other frontend-only change in this repo.

## Global Constraints

- No migration, schema change, new column, new/modified API route, or
  change to any file under `packages/database`, `packages/shared`,
  `apps/api`, or `apps/worker`. If a task's file list ever includes one of
  those, that is a plan bug — stop and flag it.
- No change to `human_locked_fields` semantics, the CPF replace-and-audit
  rule, or Helena's `update_qualification` tool behavior.
- Every existing handler being relocated (Reagendar's `POST
  /tasks/:id/reschedule`, Cancelar's `POST /tasks/:id/cancel` +
  `window.confirm()` guard, `TaskDialog`'s save flow) must keep its exact
  request/response shape and side effects — only the UI location and
  visual weight of the trigger changes.
- "Tipo de atendimento" wherever it appears (list row, panel header) means
  `TASK_TYPE_LABELS[task.type]` — the task's own type (e.g. "Follow-up de
  financiamento", "Retornar cliente") — **not**
  `qualification.attendance_type` (financing/consortium/cash/workshop),
  which is a different field used only inside the qualification sections.
  Do not conflate the two.
- Reuse existing design-system primitives (`Badge`, `Button`,
  `DropdownMenu*`, `Sheet*`, the new `Accordion*`) — no ad-hoc new visual
  patterns where an existing one already fits.
- The spec's "collapsed section shows a one-line preview" idea is
  explicitly marked optional there ("can be dropped ... if it adds too
  much complexity") and is intentionally **not** implemented by any task
  below — this is a deliberate scope cut authorized by the spec itself,
  not an oversight.
- The spec also assumed `formatRelativeTime` would ship with unit tests.
  Writing this plan surfaced that `apps/web` has no test runner configured
  at all (no `test` script, no vitest/jest dependency) — adding one for a
  single helper function would be disproportionate scope creep for a
  UI-only pass. Task 2 verifies its boundary cases manually instead,
  matching how `formatCurrencyBRL` (already in the same file, already
  untested) is verified today. Flagged here so this deviation from the
  spec's literal wording is visible, not silent.

---

### Task 1: Accordion primitive

**Files:**
- Create: `apps/web/src/components/ui/accordion.tsx`

**Interfaces:**
- Consumes: `@base-ui/react/accordion`'s `Accordion` namespace
  (`Accordion.Root`, `Accordion.Item`, `Accordion.Header`,
  `Accordion.Trigger`, `Accordion.Panel` — confirmed exports), and
  `cn()` from `@/lib/utils` (unchanged).
- Produces (for Task 7 and any future accordion use): `Accordion`,
  `AccordionItem`, `AccordionTrigger`, `AccordionContent` — the same
  component names/shapes `ui/tabs.tsx` uses for its own parts
  (`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`), so the wrapper reads
  the same way to anyone who's used that file. `AccordionItem` takes a
  required `value: string` prop (Base UI: "A unique value that identifies
  this accordion item"). `Accordion` (the root) takes `defaultValue:
  string[]` for which items start open, and defaults to `multiple` so more
  than one section can be open at once (Base UI's `multiple` prop, default
  `false` — this wrapper flips the default to `true` since every use in
  this app needs independent per-section open/closed state, not
  single-item-open accordion behavior).

- [ ] **Step 1: Write the wrapper**

```tsx
"use client"

import * as React from "react"
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Accordion({
  className,
  multiple = true,
  ...props
}: AccordionPrimitive.Root.Props) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      multiple={multiple}
      className={cn("flex flex-col", className)}
      {...props}
    />
  )
}

function AccordionItem({
  className,
  ...props
}: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b last:border-b-0", className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "flex flex-1 items-center justify-between gap-2 py-2.5 text-left text-sm font-semibold outline-none transition-all hover:text-foreground/80 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-panel-open]>svg]:rotate-180",
          className
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="overflow-hidden text-sm data-[ending-style]:animate-accordion-up data-[starting-style]:animate-accordion-down"
      {...props}
    >
      <div className={cn("pb-3", className)}>{children}</div>
    </AccordionPrimitive.Panel>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
```

Note: the `data-[ending-style]`/`data-[starting-style]` animation classes
reference keyframes (`accordion-up`/`accordion-down`) that are **not**
guaranteed to exist in this project's Tailwind theme. If `pnpm --filter web
dev` shows the panel snapping open/closed with no animation, that's
acceptable for this plan (no visual regression, just no slide animation) —
do not spend time adding keyframes to the Tailwind config; it's out of
scope. Remove the two `data-` animation classes from `AccordionContent` if
they cause a build error rather than a silent no-op.

- [ ] **Step 2: Verify it compiles and renders**

There is no test runner in `apps/web`, so verification here is manual.
Run: `pnpm --filter web dev`, then temporarily drop this into any existing
page (e.g. at the top of `apps/web/src/app/(dashboard)/tasks/page.tsx`,
removed again before committing) to eyeball it:

```tsx
<Accordion defaultValue={["a"]}>
  <AccordionItem value="a">
    <AccordionTrigger>Seção A</AccordionTrigger>
    <AccordionContent>Conteúdo A</AccordionContent>
  </AccordionItem>
  <AccordionItem value="b">
    <AccordionTrigger>Seção B</AccordionTrigger>
    <AccordionContent>Conteúdo B</AccordionContent>
  </AccordionItem>
</Accordion>
```

Expected: "Seção A" starts open showing "Conteúdo A", "Seção B" starts
closed; clicking either header toggles independently (both can be open at
once); the chevron rotates 180° when its own section is open. Remove the
scratch JSX before moving on — Task 7 is where this component gets its
real callers.

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/accordion.tsx
git commit -m "feat(web): add Accordion UI primitive wrapping @base-ui/react/accordion"
```

---

### Task 2: Compact task list row

**Files:**
- Modify: `apps/web/src/lib/utils.ts`
- Create: `apps/web/src/components/tasks/reschedule-dialog.tsx`
- Modify: `apps/web/src/components/tasks/task-card.tsx`
- Modify: `apps/web/src/components/tasks/task-list.tsx`

**Interfaces:**
- Consumes: `isHotLead`, `TASK_TYPE_LABELS`, `TASK_PRIORITY_LABELS`,
  `TASK_STATUS_LABELS` from `@aula-agente/shared` (all unchanged);
  `formatPhone` from `@/lib/utils` (unchanged); `Badge` from
  `@/components/ui/badge`.
- Produces:
  - `formatRelativeTime(iso: string | null | undefined): string` in
    `apps/web/src/lib/utils.ts` — Task 4's panel header and this task's
    list row both call it.
  - `RescheduleDialog` exported from the new
    `apps/web/src/components/tasks/reschedule-dialog.tsx` (moved verbatim
    out of `task-card.tsx`, same props `{ task: Task; onRescheduled: ()
    => void }`) — Task 4 imports it from its new location.
  - `TaskCardProps` drops `organizationId` and `onRefresh` (no longer
    needed — every mutation moves to the panel in Task 4) and gains
    nothing yet (selection highlighting is Task 3). `TaskListProps` drops
    the same two fields it no longer needs to thread through.

- [ ] **Step 1: Add `formatRelativeTime` to `apps/web/src/lib/utils.ts`**

Append this to the existing file (right after `formatCurrencyBRL`, same
file, same style — no new imports needed, it's pure `Date` arithmetic):

```ts
// Renders how long ago an ISO timestamp was, e.g. "agora", "há 12 min",
// "há 3h", "há 2 dias". Falls back to an absolute date past ~30 days —
// "há 45 dias" stops being useful information at that point. Returns a
// fixed string for null/undefined (a task's conversation can be missing).
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Sem interações registradas";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `há ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `há ${diffDays} dia${diffDays === 1 ? "" : "s"}`;
  return new Date(iso).toLocaleDateString("pt-BR");
}
```

- [ ] **Step 2: Verify the boundaries manually**

No test runner exists in `apps/web`, so check this in a scratch Node REPL
instead of writing an automated test:

```bash
cd apps/web && node -e '
const now = Date.now();
const min = (n) => new Date(now - n * 60_000).toISOString();
const hr = (n) => min(n * 60);
const day = (n) => hr(n * 24);
console.log(min(0.5));   // expect the "agora" branch when passed through formatRelativeTime
console.log(min(12));    // expect "há 12 min"
console.log(hr(3));      // expect "há 3h"
console.log(day(2));     // expect "há 2 dias"
console.log(day(1));     // expect "há 1 dia" (singular)
console.log(day(45));    // expect an absolute pt-BR date, not "há 45 dias"
'
```

You're only generating the timestamps here — mentally (or by pasting into
a `ts-node`/browser console with the function in scope) confirm each one
maps to the branch described in the comment. This is the level of
verification this repo already applies to `formatCurrencyBRL` (also
untested) — don't add a test framework for one function.

- [ ] **Step 3: Extract `RescheduleDialog` into its own file**

Create `apps/web/src/components/tasks/reschedule-dialog.tsx` with exactly
the `RescheduleDialog` function currently defined inside `task-card.tsx`
(lines 36-81 today), unchanged, now exported:

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Task } from "@aula-agente/shared";

export function RescheduleDialog({ task, onRescheduled }: { task: Task; onRescheduled: () => void }) {
  const [open, setOpen] = useState(false);
  const [dueDate, setDueDate] = useState(task.due_date);
  const [dueTime, setDueTime] = useState(task.due_time ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await apiFetch(`/tasks/${task.id}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ due_date: dueDate, due_time: dueTime || null }),
      });
      setOpen(false);
      onRescheduled();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao reagendar tarefa");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Reagendar</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reagendar tarefa</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nova data</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Novo horário (opcional)</Label>
            <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
          </div>
          <Button onClick={handleSubmit} disabled={saving} className="w-full">
            {saving ? "Salvando..." : "Confirmar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Rewrite `task-card.tsx` as a compact, button-free row**

Replace the entire file with:

```tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { formatPhone, formatRelativeTime, cn } from "@/lib/utils";
import { isHotLead, TASK_TYPE_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "@aula-agente/shared";
import type { Task } from "@aula-agente/shared";
import { Flame } from "lucide-react";

export interface TaskWithRelations extends Task {
  wa_contacts: { name: string | null; phone: string } | null;
  conversations: { last_message_at: string } | null;
}

interface TaskCardProps {
  task: TaskWithRelations;
  memberEmailsById: Record<string, string>;
  onOpenDetails: (taskId: string) => void;
}

function assigneeLabel(task: Task, memberEmailsById: Record<string, string>): string {
  if (task.assignee_type === "ai") return "Helena";
  if (task.assignee_type === "human") {
    return (task.assignee_id && memberEmailsById[task.assignee_id]) || "Responsável";
  }
  return "Sem responsável";
}

function dueLabel(task: Task): string {
  const due = new Date(`${task.due_date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const time = task.due_time ? ` ${task.due_time.slice(0, 5)}` : "";
  if (diffDays === 0) return `Vence hoje${time}`;
  if (diffDays === 1) return `Vence amanhã${time}`;
  if (diffDays < 0) return `Venceu ${due.toLocaleDateString("pt-BR")}`;
  return `Vence ${due.toLocaleDateString("pt-BR")}${time}`;
}

export function TaskCard({ task, memberEmailsById, onOpenDetails }: TaskCardProps) {
  const hot = isHotLead(task);

  return (
    <div
      className="cursor-pointer space-y-0.5 rounded-md border p-3 transition-colors hover:bg-accent/30"
      onClick={() => onOpenDetails(task.id)}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">
          {task.wa_contacts?.name || formatPhone(task.wa_contacts?.phone) || "Cliente"}
        </p>
        <div className="flex shrink-0 gap-1">
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
      <p className="text-xs text-muted-foreground">{TASK_TYPE_LABELS[task.type]}</p>
      <p className="line-clamp-2 text-sm">{task.description}</p>
      <p className="text-xs text-muted-foreground">
        {assigneeLabel(task, memberEmailsById)} · {dueLabel(task)} · {formatRelativeTime(task.conversations?.last_message_at)}
      </p>
    </div>
  );
}
```

Note: `dueLabel` is a plain local function, not exported — it only needs
`task.due_date`/`task.due_time`, both already on `Task`. `cn` is imported
but unused in this step; Task 3 uses it for the selection highlight, so
leave the import (or remove it now and re-add in Task 3 — either is fine,
just don't leave an actually-unused import when Task 2's diff is
reviewed, since that's the kind of thing a linter/reviewer will flag. To
be safe: **do not import `cn` in this step** — add it in Task 3 when it's
first used).

- [ ] **Step 5: Update `task-list.tsx`'s prop signature**

`TaskCard` no longer takes `organizationId`/`onRefresh`, so
`task-list.tsx` stops passing them (it still receives them as its own
props for now — Task 3 will decide whether `TaskList` needs any props at
all beyond `tasks`/`bucket`/`memberEmailsById`/`onOpenDetails`, don't
change `TaskListProps` in this step beyond removing the two dead
pass-throughs):

```tsx
"use client";

import { sortTasksForToday, isHotLead, type TaskBucket } from "@aula-agente/shared";
import { TaskCard, type TaskWithRelations } from "./task-card";

interface TaskListProps {
  tasks: TaskWithRelations[];
  bucket: TaskBucket;
  memberEmailsById: Record<string, string>;
  onOpenDetails: (taskId: string) => void;
}

export function TaskList({ tasks, bucket, memberEmailsById, onOpenDetails }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma tarefa aqui.</p>;
  }

  if (bucket !== "today") {
    return (
      <div className="space-y-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} memberEmailsById={memberEmailsById} onOpenDetails={onOpenDetails} />
        ))}
      </div>
    );
  }

  const sortable = tasks.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    due_time: t.due_time,
    priority: t.priority,
    lastMessageAt: t.conversations?.last_message_at ?? null,
  }));
  const sortedIds = sortTasksForToday(sortable, Date.now()).map((t) => t.id);
  const orderedTasks = sortedIds.map((id) => tasks.find((t) => t.id === id)!);

  const hot = orderedTasks.filter((t) => isHotLead(t));
  const warm = orderedTasks.filter((t) => !isHotLead(t));

  return (
    <div className="space-y-6">
      {hot.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">🔥 Leads quentes</h3>
          {hot.map((task) => (
            <TaskCard key={task.id} task={task} memberEmailsById={memberEmailsById} onOpenDetails={onOpenDetails} />
          ))}
        </div>
      )}
      {warm.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">🟡 Follow-ups</h3>
          {warm.map((task) => (
            <TaskCard key={task.id} task={task} memberEmailsById={memberEmailsById} onOpenDetails={onOpenDetails} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Update the one call site — `apps/web/src/app/(dashboard)/tasks/page.tsx`**

`<TaskList>` is called with `organizationId`/`onRefresh` props it no
longer accepts. Find that call (currently around line 130-136) and drop
those two props (leave everything else — `selectedTaskId`,
`TaskDetailPanel`, etc. — untouched; this is Task 2's only edit to
`page.tsx`, purely to keep it compiling against the new `TaskListProps`):

```tsx
      <TaskList
        tasks={bucketed[tab]}
        bucket={tab}
        memberEmailsById={memberEmailsById}
        onOpenDetails={setSelectedTaskId}
      />
```

`fetchTasks`/`onRefresh` is intentionally **not removed** from
`page.tsx` — it's still passed to `TaskDetailPanel`'s `onTaskChanged`
prop, which Task 4 wires the relocated mutations through.

**Note on intentional intermediate state:** after this task, Reagendar,
Cancelar, and the task-level "Editar" (`TaskDialog`) trigger no longer
exist anywhere in the UI — they're relocated to the panel in Task 4, not
this one. A reviewer of this task's diff should not flag their absence as
a regression; it's the deliberate, spec-approved order (list first, panel
actions second) and the plan is not complete — and would not be
merged/deployed — until Task 4 lands.

- [ ] **Step 7: Typecheck and manual check**

Run: `pnpm --filter web typecheck`
Expected: no errors (this also catches any other now-broken call site of
`TaskCard`/`TaskList`/`RescheduleDialog` — grep for
`from "./task-card"` and `RescheduleDialog` across `apps/web/src` if the
typecheck surfaces one this plan didn't anticipate).

Run `pnpm --filter web dev`, open `/tasks`: rows should be visibly more
compact than before, no buttons on any row, description clamped to 2
lines even for a long one, "🔥 Quente" as its own badge (not glued to the
name) on hot leads, due date and last-interaction both showing and
reading as two distinct pieces of information.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/utils.ts apps/web/src/components/tasks/reschedule-dialog.tsx apps/web/src/components/tasks/task-card.tsx apps/web/src/components/tasks/task-list.tsx "apps/web/src/app/(dashboard)/tasks/page.tsx"
git commit -m "feat(web): compact inbox-style task list row, drop actions (relocated in next task)"
```

---

### Task 3: Persistent selection highlight

**Files:**
- Modify: `apps/web/src/components/tasks/task-card.tsx`
- Modify: `apps/web/src/components/tasks/task-list.tsx`
- Modify: `apps/web/src/app/(dashboard)/tasks/page.tsx`

**Interfaces:**
- Consumes: `selectedTaskId` (already exists in `page.tsx` as
  `useState<string | null>`, from the task-detail-panel feature).
- Produces: `TaskCardProps` gains `isSelected: boolean`; `TaskListProps`
  gains `selectedTaskId: string | null` (compares internally, passes the
  boolean down per-row — `TaskCard` itself only needs the boolean, not the
  raw id, so it can't accidentally compare against the wrong thing).

- [ ] **Step 1: Add the highlight to `TaskCard`**

In `task-card.tsx`: add `isSelected: boolean` to `TaskCardProps`, import
`cn` from `@/lib/utils`, and change the outer `div`'s className to a
`cn()` call that reuses the exact accent-bar pattern
`app-sidebar.tsx` already uses for its active nav item:

```tsx
import { formatPhone, formatRelativeTime, cn } from "@/lib/utils";
```

```tsx
interface TaskCardProps {
  task: TaskWithRelations;
  memberEmailsById: Record<string, string>;
  isSelected: boolean;
  onOpenDetails: (taskId: string) => void;
}
```

```tsx
export function TaskCard({ task, memberEmailsById, isSelected, onOpenDetails }: TaskCardProps) {
  const hot = isHotLead(task);

  return (
    <div
      className={cn(
        "relative cursor-pointer space-y-0.5 rounded-md border p-3 transition-colors",
        isSelected ? "border-transparent bg-accent/40" : "hover:bg-accent/30"
      )}
      onClick={() => onOpenDetails(task.id)}
    >
      {isSelected && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
      {/* ...rest of the row unchanged from Task 2... */}
```

(Everything inside the `div` from Task 2's Step 4 stays exactly as
written — only the opening `<div>` tag and the new accent-bar `<span>`
change.)

- [ ] **Step 2: Thread `selectedTaskId` through `TaskList`**

In `task-list.tsx`: add `selectedTaskId: string | null` to
`TaskListProps`, and pass `isSelected={task.id === selectedTaskId}` at
every one of the three `<TaskCard>` call sites (the `bucket !== "today"`
branch, the "hot" map, and the "warm" map):

```tsx
interface TaskListProps {
  tasks: TaskWithRelations[];
  bucket: TaskBucket;
  memberEmailsById: Record<string, string>;
  selectedTaskId: string | null;
  onOpenDetails: (taskId: string) => void;
}
```

```tsx
<TaskCard
  key={task.id}
  task={task}
  memberEmailsById={memberEmailsById}
  isSelected={task.id === selectedTaskId}
  onOpenDetails={onOpenDetails}
/>
```

(Same three-line addition — `isSelected={task.id === selectedTaskId}` —
at each of the three existing `<TaskCard>` JSX blocks.)

- [ ] **Step 3: Pass `selectedTaskId` from `page.tsx`**

One line added to the existing `<TaskList>` call:

```tsx
      <TaskList
        tasks={bucketed[tab]}
        bucket={tab}
        memberEmailsById={memberEmailsById}
        selectedTaskId={selectedTaskId}
        onOpenDetails={setSelectedTaskId}
      />
```

- [ ] **Step 4: Typecheck and manual check**

Run: `pnpm --filter web typecheck` — expect no errors.

Run `pnpm --filter web dev`, open `/tasks`, click a row: it should get a
tinted background and a thin left accent bar immediately, and **stay**
highlighted while the panel (still the pre-Task-4 panel — that's fine,
Task 3 doesn't touch the panel) is open. Click a different row: the
highlight must move to the new row, not stay on the old one or appear on
both.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tasks/task-card.tsx apps/web/src/components/tasks/task-list.tsx "apps/web/src/app/(dashboard)/tasks/page.tsx"
git commit -m "feat(web): persistent left-accent highlight on the selected task row"
```

---

### Task 4: Relocate actions into the panel

**Files:**
- Modify: `apps/web/src/components/tasks/task-detail-panel.tsx`
- Modify: `apps/web/src/app/(dashboard)/tasks/page.tsx`

**Interfaces:**
- Consumes: `RescheduleDialog` from
  `@/components/tasks/reschedule-dialog` (Task 2's new location);
  `TaskDialog` from `@/components/tasks/task-dialog` (unchanged,
  untouched file); `DropdownMenu`, `DropdownMenuTrigger`,
  `DropdownMenuContent`, `DropdownMenuItem` from
  `@/components/ui/dropdown-menu` (already exists); `formatRelativeTime`
  from `@/lib/utils` (Task 2); `TaskWithRelations` from
  `@/components/tasks/task-card`; `TASK_TYPE_LABELS`,
  `TASK_PRIORITY_LABELS` from `@aula-agente/shared`.
- Produces: `TaskDetailPanelProps` gains `task: TaskWithRelations` and
  `organizationId: string` — Task 7 (which also edits this file) inherits
  these, doesn't need to add them again.

**Why `task: TaskWithRelations` instead of fetching more from the API:**
`RescheduleDialog` and `TaskDialog` both need fields
(`type`, `assignee_type`, `assignee_id`, `contact_id`, full
`wa_contacts`) that `GET /tasks/:id/details` does not return today, and
this plan cannot change that endpoint. `page.tsx` already holds the full
`TaskWithRelations` for every row it rendered via `TaskCard` — the exact
object `TaskCard` used to hand to these same two components before this
task. Passing that same object into the panel is a pure prop-threading
change, not a new fetch and not an API change.

- [ ] **Step 1: Have `page.tsx` look up and pass the full task object**

Replace the `selectedTaskId &&` conditional render block (currently near
the end of the file) with a lookup:

```tsx
      {selectedTaskId && (() => {
        const selectedTask = tasks.find((t) => t.id === selectedTaskId);
        if (!selectedTask) return null;
        return (
          <TaskDetailPanel
            task={selectedTask}
            taskId={selectedTaskId}
            organizationId={currentOrg.id}
            onClose={() => setSelectedTaskId(null)}
            onTaskChanged={() => {
              fetchTasks();
              setSelectedTaskId(null);
            }}
          />
        );
      })()}
```

(`taskId` stays — `TaskDetailPanel` still needs it for its own
`GET /tasks/:id/details` fetch of qualification data; `task` is new and
carries only what the relocated dialogs need.)

- [ ] **Step 2: Rewrite `task-detail-panel.tsx`'s header and actions**

The file's imports, types, constants (`EMPTY_QUALIFICATION`,
`URGENCY_OPTIONS`, `ATTENDANCE_TYPE_OPTIONS`, `CLIENT_FIELDS`,
`SUMMARY_FIELDS`, `FINANCING_FIELDS`, `commercialFields`,
`openWhatsApp`) stay exactly as they are today — this task only replaces
the `TaskDetailPanelProps` interface and the `TaskDetailPanel` function
body's header/actions markup (everything from `<SheetHeader>` through the
closing of the actions `<div className="flex flex-wrap gap-2">` block).
The `QualificationSection` calls below that point are untouched by this
task (Tasks 5-7 touch those).

```tsx
import type { TaskWithRelations } from "./task-card";
import { RescheduleDialog } from "./reschedule-dialog";
import { TaskDialog } from "./task-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Pencil, MoreVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TASK_TYPE_LABELS, TASK_PRIORITY_LABELS } from "@aula-agente/shared";
```

```tsx
interface TaskDetailPanelProps {
  task: TaskWithRelations;
  taskId: string;
  organizationId: string;
  onClose: () => void;
  onTaskChanged: () => void;
}

export function TaskDetailPanel({ task, taskId, organizationId, onClose, onTaskChanged }: TaskDetailPanelProps) {
  const router = useRouter();
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchDetails = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await apiFetch(`/tasks/${taskId}/details`);
      setDetails(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  const handleSaveSection = async (patch: Record<string, unknown>) => {
    if (!details?.conversation) {
      throw new Error("Esta tarefa não tem conversa vinculada — não é possível editar a qualificação.");
    }
    await apiFetch(`/conversations/${details.conversation.id}/qualification`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await fetchDetails();
  };

  const handleComplete = async () => {
    try {
      await apiFetch(`/tasks/${taskId}/complete`, { method: "POST" });
      onTaskChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao concluir tarefa");
    }
  };

  const handleCancel = async () => {
    if (!confirm("Cancelar esta tarefa?")) return;
    try {
      await apiFetch(`/tasks/${taskId}/cancel`, { method: "POST", body: JSON.stringify({}) });
      onTaskChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao cancelar tarefa");
    }
  };

  const isOpenTask = details ? details.task.status !== "completed" && details.task.status !== "cancelled" : false;
  const qualification = details?.qualification ?? EMPTY_QUALIFICATION;
  const attendanceType = qualification.attendance_type;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{details?.customer?.name || (details?.customer ? formatPhone(details.customer.phone) : "Tarefa")}</SheetTitle>
            {isOpenTask && (
              <TaskDialog
                organizationId={organizationId}
                task={task}
                presetContact={{ id: task.contact_id, name: task.wa_contacts?.name ?? null, phone: task.wa_contacts?.phone ?? "" }}
                triggerButton={<Button variant="ghost" size="icon-sm" />}
                triggerLabel={<Pencil className="size-3.5" />}
                onSaved={onTaskChanged}
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {details?.customer ? formatPhone(details.customer.phone) : ""} · {TASK_TYPE_LABELS[task.type]}
          </p>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="secondary">{TASK_PRIORITY_LABELS[task.priority]}</Badge>
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(details?.conversation?.lastMessageAt)}
            </span>
          </div>
        </SheetHeader>

        {loading && <p className="p-4 text-sm text-muted-foreground">Carregando...</p>}

        {error && (
          <div className="p-4">
            <p className="text-sm text-destructive">Não foi possível carregar os detalhes.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={fetchDetails}>
              Tentar de novo
            </Button>
          </div>
        )}

        {details && !loading && !error && (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!isOpenTask}
                onClick={handleComplete}
              >
                Concluir
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!details.task.conversation_id}
                onClick={() => details.task.conversation_id && router.push(`/inbox?id=${details.task.conversation_id}`)}
                title={!details.task.conversation_id ? "Esta tarefa não tem conversa vinculada" : undefined}
              >
                Abrir conversa
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!details.customer?.phone}
                onClick={() => details.customer?.phone && openWhatsApp(details.customer.phone)}
                title={!details.customer?.phone ? "Telefone indisponível" : undefined}
              >
                WhatsApp
              </Button>
              {isOpenTask && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto" />}>
                    <MoreVertical className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <RescheduleDialog task={task} onRescheduled={onTaskChanged} />
                    <DropdownMenuItem variant="destructive" onClick={handleCancel}>
                      Cancelar tarefa
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            <Separator />
```

(Everything from the `<QualificationSection title="Resumo do atendimento"`
call onward is untouched by this task.)

**Note on `RescheduleDialog` inside `DropdownMenuContent`:** `Reschedule
Dialog` renders its own `DialogTrigger` styled as a full `Button` (`variant="outline" size="sm"`)
today — dropped directly into a `DropdownMenuContent`, it will visually
look like a button floating inside a menu rather than a menu item. That's
an acceptable, low-risk visual wrinkle to accept for this task (its click
behavior — opening the reschedule dialog — is correct and unchanged); if
it looks wrong once it's actually on screen, the fix is trivial (wrap it
so only its trigger renders as a `DropdownMenuItem`-styled element) but is
deferred to this task's own review round rather than pre-solved here,
since it's a one-line style tweak, not a new decision.

- [ ] **Step 3: Typecheck and manual check**

Run: `pnpm --filter web typecheck` — expect no errors.

Run `pnpm --filter web dev`, open a task's panel: header shows name,
phone, task type, priority badge, and a relative last-interaction time;
pencil icon opens the same task-edit dialog "Editar" used to open from
the list; Concluir/Abrir conversa/WhatsApp still work exactly as before;
the "⋮" menu opens and contains Reagendar and a destructive-styled
"Cancelar tarefa" — clicking Cancelar still shows the `confirm()` prompt
and, on confirm, closes the panel and refreshes the list (`onTaskChanged`
fires exactly as `handleComplete` already does).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tasks/task-detail-panel.tsx "apps/web/src/app/(dashboard)/tasks/page.tsx"
git commit -m "feat(web): move Reagendar/Cancelar/Editar-tarefa into the detail panel"
```

---

### Task 5: Executive-summary truncation

**Files:**
- Modify: `apps/web/src/components/tasks/qualification-section.tsx`
- Modify: `apps/web/src/components/tasks/task-detail-panel.tsx`

**Interfaces:**
- Produces: `QualificationSectionProps` gains an optional
  `truncateSummary?: boolean` (default `false`) — when `true`, a
  `textarea`-kind field's read-mode display clamps to 3 lines with a
  "Mostrar mais"/"Mostrar menos" toggle instead of showing the full text.
  Only the panel's `Resumo do atendimento` section passes `true`;
  `Observações` (added in Task 7) does not, and keeps showing its full
  text — this prop is opt-in per section, not a global behavior change.

- [ ] **Step 1: Add the truncation toggle to `qualification-section.tsx`**

Add a tiny local component and thread the new prop through. In the
read-mode branch (`!editing`), change how a `textarea`-kind field's value
is rendered:

```tsx
import { useState } from "react";
```

(already imported — no new import needed for `useState`)

```tsx
interface QualificationSectionProps {
  title: string;
  fields: QualificationFieldDescriptor[];
  values: Record<string, unknown>;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  truncateSummary?: boolean;
}

function TruncatedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <p className={expanded ? "text-sm" : "line-clamp-3 text-sm"}>{text}</p>
      <button
        type="button"
        className="mt-1 text-xs font-medium text-primary hover:underline"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? "Mostrar menos" : "Mostrar mais"}
      </button>
    </div>
  );
}
```

```tsx
export function QualificationSection({ title, fields, values, onSave, truncateSummary = false }: QualificationSectionProps) {
```

In the read-mode `fields.map(...)` block, special-case a truncatable
textarea field so it renders `TruncatedText` instead of the plain
label/value row:

```tsx
      {!editing ? (
        <div>
          {fields.map((f) => {
            const display = formatReadValue(f, values[f.key]);
            if (truncateSummary && f.kind === "textarea" && display) {
              return <TruncatedText key={f.key} text={display} />;
            }
            return (
              <div key={f.key} className="flex items-center justify-between gap-4 py-1 text-sm">
                <span className="text-muted-foreground">{f.label}</span>
                <span className={display ? "font-medium" : "text-muted-foreground italic"}>
                  {display ?? "Não informado"}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
```

(The `"Mostrar mais"` button only appears at all because it's always
rendered by `TruncatedText` — that's intentional and simpler than
measuring whether the text actually overflows 3 lines; for a very short
summary the button just toggles between two visually identical states,
which is harmless. If this reads oddly in Task 10's visual review, note
it there — don't add scroll-height measurement logic to solve a cosmetic
edge case pre-emptively.)

- [ ] **Step 2: Pass the new prop from the panel's Resumo section**

In `task-detail-panel.tsx`, the existing call:

```tsx
            <QualificationSection
              title="Resumo do atendimento"
              fields={SUMMARY_FIELDS}
              values={qualification as unknown as Record<string, unknown>}
              onSave={handleSaveSection}
            />
```

gains one prop:

```tsx
            <QualificationSection
              title="Resumo do atendimento"
              fields={SUMMARY_FIELDS}
              values={qualification as unknown as Record<string, unknown>}
              onSave={handleSaveSection}
              truncateSummary
            />
```

- [ ] **Step 3: Typecheck and manual check**

Run: `pnpm --filter web typecheck` — expect no errors.

Run `pnpm --filter web dev`: open a task whose `summary` field is long
(edit one to a multi-paragraph value if none exist yet) — confirm it
clamps to 3 lines with "Mostrar mais" below it, clicking expands to the
full text and the button now reads "Mostrar menos", clicking again
re-collapses. Confirm editing (pencil icon on this section) still shows
the full untruncated textarea, unaffected by this change.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tasks/qualification-section.tsx apps/web/src/components/tasks/task-detail-panel.tsx
git commit -m "feat(web): truncate the Resumo section to 3 lines with a Mostrar mais toggle"
```

---

### Task 6: Compact financial stat-block cards

**Files:**
- Modify: `apps/web/src/components/tasks/qualification-section.tsx`
- Modify: `apps/web/src/components/tasks/task-detail-panel.tsx`

**Interfaces:**
- Produces: `QualificationFieldDescriptor` gains an optional
  `emphasize?: boolean` (available on every variant of the union, since
  it's read the same way regardless of `kind`). When a section's read-mode
  render encounters `emphasize: true` fields, it renders them first, as a
  2-column stat grid, before the section's remaining (non-emphasized)
  fields in their existing label/value row style. Only currency/term
  fields get `emphasize: true`, set at the four field-descriptor call
  sites in `task-detail-panel.tsx` — this task does not touch which
  section each field belongs to (that's Task 7).

- [ ] **Step 1: Add `emphasize` to the type and the read-mode renderer**

In `qualification-section.tsx`, add the optional field to every arm of
the discriminated union:

```tsx
export type QualificationFieldDescriptor =
  | { key: string; label: string; kind: "text"; emphasize?: boolean }
  | { key: string; label: string; kind: "textarea"; emphasize?: boolean }
  | { key: string; label: string; kind: "number"; emphasize?: boolean }
  | { key: string; label: string; kind: "currency"; emphasize?: boolean }
  | { key: string; label: string; kind: "date"; emphasize?: boolean }
  | { key: string; label: string; kind: "boolean"; emphasize?: boolean }
  | { key: string; label: string; kind: "select"; options: Array<{ value: string; label: string }>; emphasize?: boolean };
```

Split the read-mode block into an emphasized grid followed by the
existing row list:

```tsx
      {!editing ? (
        <div className="space-y-3">
          {fields.some((f) => f.emphasize) && (
            <div className="grid grid-cols-2 gap-2">
              {fields
                .filter((f) => f.emphasize)
                .map((f) => {
                  const display = formatReadValue(f, values[f.key]);
                  return (
                    <div key={f.key} className="rounded-md border bg-muted/30 p-2">
                      <p className={display ? "text-lg font-semibold" : "text-sm text-muted-foreground italic"}>
                        {display ?? "Não informado"}
                      </p>
                      <p className="text-xs text-muted-foreground">{f.label}</p>
                    </div>
                  );
                })}
            </div>
          )}
          <div>
            {fields
              .filter((f) => !f.emphasize)
              .map((f) => {
                const display = formatReadValue(f, values[f.key]);
                if (truncateSummary && f.kind === "textarea" && display) {
                  return <TruncatedText key={f.key} text={display} />;
                }
                return (
                  <div key={f.key} className="flex items-center justify-between gap-4 py-1 text-sm">
                    <span className="text-muted-foreground">{f.label}</span>
                    <span className={display ? "font-medium" : "text-muted-foreground italic"}>
                      {display ?? "Não informado"}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      ) : (
```

(This replaces the single `<div>{fields.map(...)}</div>` block Task 5
left in place — the `truncateSummary`/`TruncatedText` branch from Task 5
is preserved verbatim inside the new non-emphasized loop, just
re-indented under the `.filter((f) => !f.emphasize)` map instead of the
unfiltered one.)

- [ ] **Step 2: Mark the four money/term fields as `emphasize` in `task-detail-panel.tsx`**

In `commercialFields()`, add `emphasize: true` to exactly these four
descriptors (`sale_amount`, the `down_payment_amount` branch, and the two
already-present tail fields):

```tsx
function commercialFields(attendanceType: string | null): QualificationFieldDescriptor[] {
  const base: QualificationFieldDescriptor[] = [
    { key: "product_interest", label: "Produto", kind: "text" },
    { key: "product_model", label: "Modelo", kind: "text" },
    { key: "sale_amount", label: "Valor da venda", kind: "currency", emphasize: true },
  ];
  const financialFields: QualificationFieldDescriptor[] =
    attendanceType === "consortium"
      ? [
          { key: "credit_amount", label: "Crédito desejado", kind: "currency", emphasize: true },
          { key: "bid_amount", label: "Lance", kind: "currency", emphasize: true },
        ]
      : [{ key: "down_payment_amount", label: "Entrada", kind: "currency", emphasize: true }];
  return [
    ...base,
    ...financialFields,
    { key: "target_installment_amount", label: "Parcela desejada", kind: "currency", emphasize: true },
    { key: "term_months", label: "Prazo (meses)", kind: "number", emphasize: true },
    { key: "next_action", label: "Próxima ação", kind: "text" },
    { key: "commercial_notes", label: "Observações", kind: "textarea" },
  ];
}
```

(This task does not yet split `credit_amount`/`bid_amount`/
`commercial_notes` into their own sections — that's Task 7. For now
they're still emphasized/plain fields inside the one
`commercialFields()` array, exactly where they were before this task,
just with the new visual treatment where it applies.)

- [ ] **Step 3: Typecheck and manual check**

Run: `pnpm --filter web typecheck` — expect no errors.

Run `pnpm --filter web dev`: open "Informações comerciais" on a task with
real values for sale/down-payment/installment/term — confirm those four
render as a 2×2 grid of bold numbers with small muted labels, while
Produto/Modelo/Próxima ação/Observações still render as plain label/value
rows below the grid. Open a task with `attendance_type === "consortium"`
— confirm Crédito desejado/Lance appear as stat blocks too (they'll sit
inside the same section until Task 7 moves them into "Consórcio").

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tasks/qualification-section.tsx apps/web/src/components/tasks/task-detail-panel.tsx
git commit -m "feat(web): render sale/down-payment/installment/term as emphasized stat blocks"
```

---

### Task 7: Accordion sections, including the new Consórcio/Observações split

**Files:**
- Modify: `apps/web/src/components/tasks/task-detail-panel.tsx`
- Modify: `apps/web/src/components/tasks/qualification-section.tsx`

**Interfaces:**
- Consumes: `Accordion`, `AccordionItem`, `AccordionTrigger`,
  `AccordionContent` from `@/components/ui/accordion` (Task 1).
- Produces: `QualificationSectionProps` gains an optional `titleAction`
  slot is **not** needed — the pencil-icon "Editar" trigger already lives
  inside `QualificationSection` itself (it's the existing `!editing &&`
  button); this task only changes what wraps each `QualificationSection`
  instance from the outside (a plain `<div>...<Separator /></div>` stack
  today, an `AccordionItem` after this task) and swaps that button's
  content from the text "Editar" to a `Pencil` icon.
- New field-descriptor arrays in `task-detail-panel.tsx`:
  `CONSORTIUM_FIELDS` (credit_amount, bid_amount — both `emphasize:
  true`) and `OBSERVATION_FIELDS` (commercial_notes). `commercialFields()`
  drops both from its own return value (they move to the two new arrays).

- [ ] **Step 1: Replace the "Editar" text button with a pencil icon in `qualification-section.tsx`**

```tsx
import { Pencil } from "lucide-react";
```

```tsx
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {!editing && (
          <Button variant="ghost" size="icon-sm" onClick={startEditing}>
            <Pencil className="size-3.5" />
          </Button>
        )}
      </div>
```

- [ ] **Step 2: Split `commercialFields()` and add the two new field arrays**

In `task-detail-panel.tsx`:

```tsx
function commercialFields(): QualificationFieldDescriptor[] {
  return [
    { key: "product_interest", label: "Produto", kind: "text" },
    { key: "product_model", label: "Modelo", kind: "text" },
    { key: "sale_amount", label: "Valor da venda", kind: "currency", emphasize: true },
    { key: "down_payment_amount", label: "Entrada", kind: "currency", emphasize: true },
    { key: "target_installment_amount", label: "Parcela desejada", kind: "currency", emphasize: true },
    { key: "term_months", label: "Prazo (meses)", kind: "number", emphasize: true },
    { key: "next_action", label: "Próxima ação", kind: "text" },
  ];
}

const CONSORTIUM_FIELDS: QualificationFieldDescriptor[] = [
  { key: "credit_amount", label: "Crédito desejado", kind: "currency", emphasize: true },
  { key: "bid_amount", label: "Lance", kind: "currency", emphasize: true },
];

const OBSERVATION_FIELDS: QualificationFieldDescriptor[] = [
  { key: "commercial_notes", label: "Observações", kind: "textarea" },
];
```

`commercialFields()` no longer takes `attendanceType` as a parameter —
the consortium-specific fields moved to their own array entirely, so
there's nothing left in it that branches on attendance type. Update its
one call site accordingly (Step 3).

- [ ] **Step 3: Rebuild the section stack as an accordion**

Replace everything from the first `<Separator />` after the actions row
(the block Task 4 left ending in `<Separator />` right before
`<QualificationSection title="Resumo do atendimento"`) through the end of
the conditional `Financiamento` block with:

```tsx
            <Accordion defaultValue={["resumo", "comercial"]}>
              <AccordionItem value="resumo">
                <AccordionTrigger>Resumo do atendimento</AccordionTrigger>
                <AccordionContent>
                  <QualificationSection
                    title="Resumo do atendimento"
                    fields={SUMMARY_FIELDS}
                    values={qualification as unknown as Record<string, unknown>}
                    onSave={handleSaveSection}
                    truncateSummary
                  />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="comercial">
                <AccordionTrigger>Informações comerciais</AccordionTrigger>
                <AccordionContent>
                  <QualificationSection
                    title="Informações comerciais"
                    fields={commercialFields()}
                    values={qualification as unknown as Record<string, unknown>}
                    onSave={handleSaveSection}
                  />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="cliente">
                <AccordionTrigger>Dados do cliente</AccordionTrigger>
                <AccordionContent>
                  <QualificationSection
                    title="Dados do cliente"
                    fields={CLIENT_FIELDS}
                    values={qualification as unknown as Record<string, unknown>}
                    onSave={handleSaveSection}
                  />
                  {details.conversation && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Última interação: {new Date(details.conversation.lastMessageAt).toLocaleString("pt-BR")}
                    </p>
                  )}
                </AccordionContent>
              </AccordionItem>

              {attendanceType === "financing" && (
                <AccordionItem value="financiamento">
                  <AccordionTrigger>Financiamento</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Financiamento"
                      fields={FINANCING_FIELDS}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                    />
                  </AccordionContent>
                </AccordionItem>
              )}

              {attendanceType === "consortium" && (
                <AccordionItem value="consorcio">
                  <AccordionTrigger>Consórcio</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Consórcio"
                      fields={CONSORTIUM_FIELDS}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                    />
                  </AccordionContent>
                </AccordionItem>
              )}

              <AccordionItem value="observacoes">
                <AccordionTrigger>Observações</AccordionTrigger>
                <AccordionContent>
                  <QualificationSection
                    title="Observações"
                    fields={OBSERVATION_FIELDS}
                    values={qualification as unknown as Record<string, unknown>}
                    onSave={handleSaveSection}
                  />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
```

Add the import:

```tsx
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
```

The `<Separator />` elements that used to sit between each section are no
longer needed — `AccordionItem`'s own `border-b` (from Task 1's wrapper)
now provides that visual separation. Remove the `Separator` import if
nothing else in this file still uses it (check — as of Task 4 it wasn't
otherwise referenced).

- [ ] **Step 4: Typecheck and manual check**

Run: `pnpm --filter web typecheck` — expect no errors.

Run `pnpm --filter web dev`: open a financing task — "Resumo" and
"Informações comerciais" start open, "Dados do cliente"/"Financiamento"/
"Observações" start closed, "Consórcio" doesn't render at all. Open a
consortium task — "Consórcio" renders (closed by default) showing Crédito
desejado/Lance as stat blocks, "Financiamento" doesn't render. Click each
collapsed section — it expands independently without closing the others.
Edit a field inside any section (pencil icon) — save/cancel behaves
exactly as before (same `handleSaveSection` call, same
`human_locked_fields`-preserving `draftToPatch` logic, untouched).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tasks/task-detail-panel.tsx apps/web/src/components/tasks/qualification-section.tsx
git commit -m "feat(web): wrap panel sections in an accordion, split out Consórcio and Observações"
```

---

### Task 8: State-preservation verification

**Files:**
- None expected. This task is verification-only — Tasks 2-7 kept `tab`
  and `selectedTaskId` as the same sibling `useState`s in `page.tsx` they
  already were, and kept `TaskList`/`TaskCard` mounted with stable
  `key={task.id}` throughout every rewrite, so no regression should exist
  to fix. If manual testing (Step 1) finds one, fix it in this task and
  say so in the report — don't silently patch it into an earlier task's
  diff.

**Interfaces:**
- Consumes: everything Tasks 2-7 already produced. Nothing new.

- [ ] **Step 1: Manual regression pass**

Run `pnpm --filter web dev`, open `/tasks`, and walk through:

1. Switch to the "Atrasadas" tab, scroll the list down, click a task
   near the bottom. Confirm: the tab stays "Atrasadas" (doesn't reset to
   "Hoje"), and the list's scroll position doesn't jump back to the top
   when the panel opens.
2. With the panel open, click "Concluir". Confirm: the panel closes
   (`selectedTaskId` back to `null`), the list refetches, and you're
   still on the "Atrasadas" tab (the task just completed should now be
   gone from that bucket).
3. Open a different task, then click the Sheet's own close ("✕")
   instead of completing it. Confirm: the row's highlight disappears
   (compare against Task 3's highlight), the tab and scroll position are
   unaffected, and the task itself is untouched (still shows in the same
   bucket on reopening the panel).
4. Switch tabs a few times (Hoje → Próximas → Concluídas → Hoje) with no
   panel open. Confirm each tab's own list renders correctly and no
   selection highlight leaks across tabs (a task selected on "Hoje" should
   not appear highlighted if it happens to also render in another bucket
   — it won't, since buckets are mutually exclusive by construction in
   `resolveTaskBucket`, but confirm visually anyway).

- [ ] **Step 2: If anything regressed, fix it here and note it in the task report**

There is no anticipated code change for this task. If Step 1 surfaces a
real regression, the fix belongs in whichever file is actually wrong
(most likely `page.tsx` if it's a tab/selection interaction, or
`task-list.tsx` if it's a remounting/key issue) — make the smallest
possible fix, re-run Step 1's full checklist, then commit.

- [ ] **Step 3: Commit (only if Step 2 made a change)**

```bash
git add -A
git commit -m "fix(web): preserve tab/scroll/selection state across panel open-close"
```

If Step 1 found nothing to fix, skip this step entirely — an empty commit
is not useful, and the task report should say "verified, no regression
found" instead.

---

### Task 9: Responsiveness pass

**Files:**
- Modify: `apps/web/src/components/tasks/task-detail-panel.tsx`

**Interfaces:**
- No new interfaces — this is a single className change plus manual
  viewport verification.

- [ ] **Step 1: Widen the panel**

Change the `Sheet`'s content className from `sm:max-w-md` to
`sm:max-w-lg`:

```tsx
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
```

- [ ] **Step 2: Manual viewport check**

Run `pnpm --filter web dev`. Using the browser's responsive/device
toolbar (or resizing the window):

- At a typical desktop width (≥1280px): confirm the panel doesn't feel
  cramped — the 2-column stat grid from Task 6 should have visible
  breathing room, not text wrapping awkwardly inside each stat block.
- At a narrow width (~375px, mobile): confirm `SheetContent`'s existing
  `w-full` still makes the panel take the full viewport width below the
  `sm:` breakpoint (unchanged behavior — this task only affects the `sm:`
  and up size), and that the compact list rows from Task 2 don't overflow
  horizontally (badges wrapping to a second line under the name is
  acceptable; horizontal scroll on the page is not).
- At a mid-width (~768px, tablet): confirm the panel width doesn't exceed
  the viewport in a way that pushes it off-screen or forces horizontal
  scroll.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tasks/task-detail-panel.tsx
git commit -m "feat(web): widen the detail panel to fit the stat-block grid comfortably"
```

---

### Task 10: Final visual review

**Files:**
- None. This task produces a comparison artifact (screenshots +
  written notes), not a code change.

**Interfaces:**
- Consumes: the fully-implemented screen from Tasks 1-9.

- [ ] **Step 1: Capture "before" reference**

Before this task, no "before" screenshot exists yet (the redesign has
already been implemented by Task 9). Check out the commit immediately
before Task 1's (`git log --oneline` to find the tip of `main`/the
branch's base commit this plan started from), run
`pnpm --filter web dev` against that commit in a **separate** terminal or
worktree (do not touch the working tree currently mid-plan — use
`git worktree add` against the base commit, or simply `git stash`-free:
`git show <base-commit>:apps/web/src/... ` is not viable for a running
dev server, so a throwaway `git worktree add /tmp/tasks-before
<base-commit-sha>` + `pnpm install` + `pnpm --filter web dev --port 3001`
is the reliable way to run both versions side by side), and capture:
- The `/tasks` list with a mix of hot/warm/overdue tasks visible.
- An open task panel (financing type, so Financiamento renders) fully
  scrolled to show its total height today.

- [ ] **Step 2: Capture "after" screenshots on this branch**

Back on this branch (`pnpm --filter web dev`), capture the same two
views: the list, and the same task's panel (all default-open/closed
accordion sections in their default state, not manually expanded).

- [ ] **Step 3: Write the before/after comparison**

Produce a short written comparison (this can be the task's report to the
controller, or a scratch markdown file — whichever this repo's review
process for a finished plan expects) covering, concretely:
- Row height / vertical space used by N tasks before vs. after.
- Total panel scroll height before vs. after, for the same task with the
  same data.
- Confirm every spec requirement from
  `specs/2026-08-05-tasks-inbox-ux-design.md` has a visible, checkable
  counterpart in the "after" screenshots (compact row, no list actions,
  persistent highlight, enriched header, accordion defaults, stat-block
  numbers, Consórcio/Observações present, Reagendar/Cancelar/Editar in the
  panel).
- Any visual rough edge found along the way (e.g. the `RescheduleDialog`
  button-inside-menu wrinkle flagged in Task 4, or the animation
  keyframes flagged in Task 1) — call out which were fixed and which were
  deliberately left as documented, acceptable follow-ups.

- [ ] **Step 4: Clean up the throwaway "before" worktree**

```bash
git worktree remove /tmp/tasks-before
```

- [ ] **Step 5: Present the comparison to the user**

This is the plan's final gate the user explicitly asked for — do not mark
the plan complete without this side-by-side having actually been shown
and reviewed, not just described in prose.
