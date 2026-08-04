# Task Detail Panel — Design

## Goal

Turn the "Tarefas" screen into a fast follow-up execution surface: clicking a
task opens a side panel showing the customer's current commercial context
(what they want, what they've committed to, what's still missing, next
action) without the salesperson re-reading the whole conversation, plus a
one-click way to continue the conversation (in-system or WhatsApp). Helena
keeps this context up to date automatically as she talks to customers; a
human can also fill in or correct it manually.

Tasks stay exactly what they are today: an ephemeral "come back to this"
marker, not a permanent customer record. The commercial context itself
(product interest, values, CPF, next action, summary) belongs to the
**conversation**, not the task — it outlives any single task, survives task
completion, and is reused by whichever task references that conversation
next.

## Confirmed current behavior (verified against source, not assumed)

- `tasks.ai_summary` exists as a column (`supabase/migrations/00010_tasks.sql`)
  but is **never written** — `createTaskWithDedup`
  (`packages/database/src/queries/tasks.ts:186`) hardcodes it to `null`, and
  no other code path sets it.
- `wa_contacts.metadata` (jsonb) and `conversations.tags` (text[]) both exist
  but are never used for commercial/qualification data — confirmed zero
  writers.
- **No structured commercial/qualification data exists anywhere in this
  codebase today** — no `qualification`/`lead_profile`/`commercial_info`
  table, column, or type, in migrations or code. Everything Helena or a
  human currently knows about a customer's product interest, budget, CPF,
  etc. lives only as prose inside `messages.content`.
- **No persisted AI conversation summary exists anywhere** (checked every
  worker, every route, every type) — the `tasks.ai_summary` column is the
  closest thing, and it's unused.
- The Tasks page (`apps/web/src/app/(dashboard)/tasks/page.tsx:37-41`) fetches
  tasks directly via the Supabase browser client, joined only with
  `wa_contacts(name, phone)` and `conversations(last_message_at)` — no API
  route exists for reading tasks today. There is no `GET /tasks` or
  `GET /tasks/:id` endpoint; only mutation routes exist
  (`apps/api/src/routes/tasks/index.ts`: create, `PATCH /tasks/:id`,
  `/complete`, `/cancel`, `/reschedule`).
- `TaskCard` (`apps/web/src/components/tasks/task-card.tsx`) is the only
  per-task UI today — no detail/side panel exists. It already has an "Abrir
  conversa" button routing to `/inbox?id=<conversation_id>`
  (`task-card.tsx:128-131`).
- The org-ownership check idiom used by every existing task mutation route
  (`getTaskById` → check `request.user.memberships` contains the row's
  `organization_id`, else 403 — e.g. `tasks/index.ts:91-96`) is the pattern
  this feature's new routes follow.
- No WhatsApp deep-link (`wa.me`/`whatsapp://`) exists anywhere in the
  frontend today.
- No PII masking/reveal pattern exists. The closest analog,
  `organization_secrets` (used for LLM API keys), is protected by an
  RLS policy restricting it to `owner`/`admin` roles
  (`00008_rls_policies.sql:66-75`) — despite the column being named
  `encrypted_key`, no actual encryption is implemented anywhere in this
  codebase; protection today is role-gated row access only. This feature's
  CPF encryption (see Architecture) is genuinely new infrastructure, not a
  reuse of an existing mechanism.
- `packages/agent-runtime/src/tools/create-task.ts` (`createCreateTaskTool`)
  is the reference pattern for a new Helena tool: takes a
  `{contactId, conversationId, organizationId}` context, a zod input schema,
  wraps its DB call in try/catch so a failure returns a string instead of
  throwing (never kills the model's turn), and is registered in
  `packages/agent-runtime/src/tools/registry.ts` behind a `tools_config`
  flag with a parallel mock version for the playground/sandbox.

## Non-goals

- Not a CRM. No lead pipeline, no multi-person applicant modeling, no
  contact-level (as opposed to conversation-level) history browser.
- No `conversation_qualification_people` table in this pass — only one
  active CPF/identity per conversation qualification. The schema is
  documented to make that future extension straightforward (see
  Architecture), but it is not built now.
- No masking or a separate "reveal CPF" endpoint. The panel is
  employee-only, behind the same organization membership check as every
  other customer datum in this app — CPF displays plainly in
  `GET /tasks/:id/details`, gated by the same org-ownership check as the
  rest of that response, nothing extra.
- No pre-filled WhatsApp message text in this pass.
- No changes to task creation, dedup, completion, cancellation,
  rescheduling, `task_events`, the follow-up worker, Prompt Builder,
  Trainer, Playground, or the existing Tasks screen filters/tabs.
- Completing, cancelling, or rescheduling a task never touches
  `conversation_qualifications` — the qualification row's lifecycle is
  independent of any one task's lifecycle.

## Architecture

### `conversation_qualifications`

One row per conversation (`conversation_id UNIQUE`), created on first write
(by either a human edit or Helena's tool), read by every task that
references that conversation.

```sql
CREATE TABLE conversation_qualifications (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,

  attendance_type text,           -- 'financing' | 'consortium' | 'cash' | 'workshop'
  product_interest text,
  product_model text,
  usage_purpose text,
  city text,
  urgency text,                   -- 'immediate' | 'this_week' | 'flexible'

  sale_amount numeric,
  credit_amount numeric,
  down_payment_amount numeric,
  bid_amount numeric,             -- consórcio lance, distinct from down_payment_amount
  target_installment_amount numeric,
  term_months integer,

  cpf_encrypted text,             -- AES-256-GCM ciphertext, decrypted server-side only
  cpf_hash text,                  -- HMAC-SHA256, used to detect a CPF change without decrypting
  birth_date date,
  has_driver_license boolean,
  driver_license_category text,

  summary text,
  next_action text,
  commercial_notes text,

  human_locked_fields text[] NOT NULL DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_qualifications_contact ON conversation_qualifications(contact_id);
```

**Future extension path (documented, not built):** `cpf_hash` (dedup
detection), `cpf_encrypted` (encryption), and the `cpf_replaced` event (audit
trail) are exactly the pieces a future `conversation_qualification_people`
table would need — extending to multiple people later means moving these
four columns into a child table keyed by a new `person_id`, without
redesigning the crypto or audit approach.

### `conversation_qualification_events` (audit trail)

```sql
CREATE TABLE conversation_qualification_events (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_qualification_id uuid NOT NULL REFERENCES conversation_qualifications(id) ON DELETE CASCADE,
  event_type text NOT NULL,       -- 'field_updated' | 'cpf_replaced'
  changed_fields jsonb,           -- field names + new non-sensitive values; NEVER the CPF value itself
  changed_by_type text NOT NULL,  -- 'human' | 'ai'
  changed_by_id uuid,             -- auth.users.id when changed_by_type = 'human', else null
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_qualification_events_qualification
  ON conversation_qualification_events(conversation_qualification_id);
```

Both tables get standard org-scoped RLS (the generic `organization_id IN
(SELECT get_user_org_ids())` policy already applied to most tables via
`00008_rls_policies.sql`'s loop) — this is shared operational data readable
by any org member, not per-user data like `conversation_reads`, so the
generic pattern is correct here (unlike that table, which needed dedicated
policies).

### Merge rules — two distinct rules for two distinct kinds of fields

**Commercial fields** (`attendance_type`, `product_interest`,
`product_model`, `usage_purpose`, `city`, `urgency`, all the monetary/term
fields, `summary`, `next_action`, `commercial_notes`): governed by
`human_locked_fields`.

- Helena's tool only writes a field if it is **not** present in
  `human_locked_fields` (whether the field is currently null or already has
  an AI-set value — she can freely update her own prior values as the
  conversation evolves).
- A human edit through the panel's form always writes the field **and**
  adds its name to `human_locked_fields` — Helena will never silently
  overwrite a human correction again.
- Clearing a field to blank through the form removes it from
  `human_locked_fields` too — that's how a salesperson hands a field back
  to Helena.

**Identity fields** (`cpf_encrypted`/`cpf_hash`, `birth_date`,
`has_driver_license`, `driver_license_category`): governed by a distinct
"replace and audit" rule, from either a human edit or Helena's tool —
`human_locked_fields` does not apply to these.

- No CPF on file yet → write directly, no event (nothing to replace).
- New CPF's hash matches the stored `cpf_hash` → no-op, idempotent (the
  same CPF mentioned twice is not a change).
- New CPF's hash differs from the stored one → **replace**: encrypt and
  store the new CPF, log a `cpf_replaced` event (`changed_fields` holds
  only non-sensitive markers, e.g. `{"previous_hash": "...", "new_hash":
  "..."}` — never a CPF value in any form), and overwrite
  `birth_date`/`has_driver_license`/`driver_license_category` with
  whatever new values came in the same write (or clear them to null if not
  provided) — a different CPF almost always means a different person, so
  their identity fields shouldn't linger attached to it.

This logic is implemented **once**, in a shared
`upsertConversationQualification` function in
`packages/database/src/queries/conversation-qualification.ts`, called by
both the `PATCH` endpoint (human path, `changed_by_type: 'human'`) and
Helena's tool (`changed_by_type: 'ai'`) — the only difference between the
two callers is which `changed_by_type` they pass and that only the human
path forces `human_locked_fields` additions.

### CPF encryption

New module, `packages/database/src/crypto/cpf.ts`:
`encryptCpf(plain: string): string`, `decryptCpf(ciphertext: string): string`
(AES-256-GCM, key from a new `QUALIFICATION_CPF_ENCRYPTION_KEY` env var —
32-byte, base64), and `hashCpf(plain: string): string` (HMAC-SHA256, keyed by
a separate `QUALIFICATION_CPF_HASH_PEPPER` env var — deliberately a
different secret from the encryption key, so either one leaking alone
doesn't compromise the other). Both env vars must be generated and set on
the `api` service before this feature does anything with CPFs — same
"missing env var" caveat this project has hit before (the `OPENAI_API_KEY`
gap noted in the audio-transcription plan).

Encryption happens only in `apps/api` (never in the browser, never in
`apps/worker`) — `GET /tasks/:id/details` decrypts server-side and returns
the plain CPF in its response, protected by the same org-membership check
already gating every other field in that response. No masking, no separate
reveal step (per explicit decision — this panel is for authenticated,
org-scoped employees only, same trust level as every other customer datum
already visible in this dashboard).

### `tasks.ai_summary` — optional snapshot, not a source of truth

`createTaskWithDedup` (`packages/database/src/queries/tasks.ts`) is extended
to look up the conversation's current `conversation_qualifications.summary`
(if a qualification row exists) and copy it into the new task's
`ai_summary` at creation time. This is a one-time photograph of "what we
knew when this task was made" — nothing ever reads it back as a live value.
The panel always displays `conversation_qualifications.summary` (via
`task.conversation_id`), never `tasks.ai_summary`.

### Endpoints (`apps/api/src/routes/tasks/index.ts`, new routes)

**`GET /tasks/:taskId/details`** — `getTaskById` → org-membership check
(existing idiom) → fetch `wa_contacts` by `contact_id`, `conversations` by
`conversation_id` (for `last_message_at`), and
`conversation_qualifications` by `conversation_id` (`maybeSingle` — may not
exist yet). Decrypts `cpf_encrypted` if present. Single round trip, no N+1
(three lookups by already-known foreign keys, not a loop).

**`PATCH /conversations/:conversationId/qualification`** — fetch the
conversation first (need its `organization_id` to check membership, since
there's no task in scope at this URL), then call
`upsertConversationQualification` with `changed_by_type: 'human'`,
`changed_by_id: request.user.id`. Creates the row if none exists yet for
this conversation.

No `reveal-cpf` endpoint (removed per explicit decision).

### Helena's tool — `updateConversationQualification`

New file `packages/agent-runtime/src/tools/update-conversation-qualification.ts`,
following `createCreateTaskTool`'s exact shape: context
`{contactId, conversationId, organizationId}`, zod input schema with every
qualification field optional (Helena only passes what she just learned this
turn), calls `upsertConversationQualification` with `changed_by_type: 'ai'`
inside a try/catch (a DB failure becomes a string result, never throws and
kills her turn). Registered in `registry.ts` behind a new
`tools_config.updateQualification` boolean, with a parallel
`createMockUpdateConversationQualificationTool` for the playground/sandbox
(no DB write, matches the existing mock-tool pattern).

## Frontend

### Panel

New `TaskDetailPanel` component, reusing `Sheet`/`SheetContent`/
`SheetHeader`/`SheetTitle` from `@/components/ui/sheet` (the exact
primitive `ChatPanel`'s existing `SidePanel` already uses). The Tasks page
gains a `selectedTaskId` state; clicking a `TaskCard`'s body (not its
existing action buttons, which already stop propagation for their own
clicks) sets it and opens the Sheet. List, filters, tabs, and scroll
position are untouched — the Sheet overlays, it doesn't navigate.
Reselecting a different task while the panel is open just refetches
`GET /tasks/:id/details` for the new id.

```text
┌──────────────────────────────────────┐
│ João Silva                      [X]  │
│ (62) 99999-9999                      │
│ Honda Bros seminova                  │
│ Em andamento · Alta prioridade       │
│ Responsável: Weslley · Hoje, 16:00   │
│                                       │
│ [Abrir conversa]  [WhatsApp]         │
│ [Concluir]  [Reagendar]  [⋯]         │
├───────────────────────────────────────┤
│ RESUMO DO ATENDIMENTO          [✎]   │
│ Cliente de Guarani de Goiás procura  │
│ moto seminova pra trabalho...        │
├───────────────────────────────────────┤
│ DADOS DO CLIENTE                [✎]  │
│ Cidade            Guarani de Goiás   │
│ Finalidade de uso  Trabalho          │
│ Urgência           Imediata          │
│ Última interação   Hoje, 15:33       │
├───────────────────────────────────────┤
│ INFORMAÇÕES COMERCIAIS          [✎]  │
│ Produto            Honda Bros semin. │
│ Valor da venda      R$ 22.000        │
│ Entrada              R$ 5.000        │
│ Parcela desejada     R$ 600          │
│ Próxima ação: Fazer simulação        │
├───────────────────────────────────────┤
│ FINANCIAMENTO                   [✎]  │
│ CPF                 123.260.361-05   │
│ Nascimento           04/11/1994      │
│ CNH                  Sim — categoria A│
└───────────────────────────────────────┘
```

- Each section has an edit affordance (`✎`) turning its values into an
  inline form; saving calls `PATCH /conversations/:conversationId/qualification`
  with just that section's fields.
- Empty field renders "Não informado," never blank, never invented.
- Section visibility by `attendance_type`: "FINANCIAMENTO" only for
  `financing`; a "CONSÓRCIO" section (crédito desejado, lance, entrada,
  prazo — bid vs. down-payment kept visually distinct per the original
  request) only for `consortium`; cash purchase and workshop show only
  their pertinent fields (per spec sections 6 in the original request).
- Values in BRL via `Intl.NumberFormat('pt-BR', { style: 'currency',
  currency: 'BRL' })` — no currency-formatting helper exists yet in
  `apps/web/src/lib/utils.ts`, this feature adds one (mirroring the
  existing `formatPhone` helper's style).

### "Abrir no WhatsApp" button

`https://wa.me/<digits>` only — no `whatsapp://` custom-scheme attempt.
`wa.me` already does exactly what was asked (opens the installed app if
registered, desktop or mobile, otherwise falls back to WhatsApp Web) in one
reliable action; a custom-scheme-plus-JS-fallback trick is fragile across
browsers/OSes and adds risk without benefit here.

```ts
const digits = phone.replace(/\D/g, "");
const withCountryCode = digits.startsWith("55") ? digits : `55${digits}`;
window.open(`https://wa.me/${withCountryCode}`, "_blank");
```

No pre-filled message text in this pass.

### UI states

- **Loading**: skeleton per section, not the whole Sheet blocked.
- **Fetch error**: inline message + retry button, panel doesn't crash.
- **No qualification row yet** (nothing ever written for this
  conversation): every field shows "Não informado" — this is the normal
  first-time state, not an error.
- **Missing/invalid phone**: "WhatsApp" button disabled with a tooltip.
- **Task completed/cancelled**: panel opens normally (qualification data is
  independent of task status), but "Concluir"/"Reagendar" are disabled.
- **Edit save fails**: form keeps the typed values, shows the error, never
  silently discards user input.

## Testing

- Pure functions extracted and unit-tested in `packages/database` (or
  `packages/shared` if they don't need DB types): the CPF-replace decision
  (`shouldReplaceCpf(existingHash, newHash): boolean`), the
  `human_locked_fields` merge (`applyFieldLock(existing: string[], newKeys:
  string[]): string[]`), and the encrypt/decrypt/hash round-trip in
  `crypto/cpf.ts` (encrypt then decrypt returns the original; two different
  CPFs hash differently; the same CPF hashes identically every time).
- `upsertConversationQualification`'s full merge logic, the new API routes,
  Helena's new tool, and the frontend panel are verified manually against
  the real running services — matching this codebase's established
  convention (no route-handler tests, no `apps/web` test infra).
