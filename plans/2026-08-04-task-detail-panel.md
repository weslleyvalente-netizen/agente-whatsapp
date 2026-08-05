# Task Detail Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a task on the Tarefas screen opens a side panel showing the conversation's current commercial context (product interest, values, CPF/financing details, AI summary, next action) — backed by a real structured table Helena keeps updated automatically, with manual editing available too — plus one-click "open conversation" / "open WhatsApp" actions.

**Architecture:** A new `conversation_qualifications` table (one row per conversation, not per task — tasks reference `conversation_id` and always read the current row) holds commercial + CPF/identity data. Two independent merge rules govern writes: commercial fields lock against AI overwrite the moment a human edits them (`human_locked_fields`); CPF/identity fields instead use a replace-and-audit rule (`conversation_qualification_events`, event type `cpf_replaced`) since a different CPF usually means a different person, not a correction to lock against. Both the new `PATCH` endpoint (human) and a new Helena tool (`ai`) funnel through one shared `upsertConversationQualification` function, so the merge logic exists exactly once. CPF is encrypted at rest (AES-256-GCM) and returned in full (no masking, no separate reveal endpoint) by the same org-scoped `GET /tasks/:taskId/details` endpoint that returns everything else — this panel is for authenticated employees only, same trust level as the rest of the dashboard.

**Tech Stack:** Postgres/Supabase (new migration + RLS, standard org-scoped pattern), Node's built-in `crypto` module (AES-256-GCM + HMAC-SHA256, no new dependency), Fastify routes (`apps/api`), an `ai`-package tool (`packages/agent-runtime`, same shape as the existing `createCreateTaskTool`), Next.js 16 client components + the existing `Sheet` primitive (`apps/web`), vitest for every pure function this feature introduces.

## Global Constraints

- `conversation_qualifications` is keyed by `conversation_id` (`UNIQUE`), **not** by task — a conversation can have many tasks over its lifetime, all reading/writing the same qualification row. Completing/cancelling/rescheduling a task never touches this table. (spec, Goal + Non-goals)
- Two independent merge rules, never conflated:
  - **Commercial fields** (`attendance_type`, `product_interest`, `product_model`, `usage_purpose`, `city`, `urgency`, `sale_amount`, `credit_amount`, `down_payment_amount`, `bid_amount`, `target_installment_amount`, `term_months`, `summary`, `next_action`, `commercial_notes`): a human write always applies and adds the field's name to `human_locked_fields`; an AI write only applies to fields **not** in `human_locked_fields`; clearing a field to null/empty via a human write removes it from `human_locked_fields`. (spec, Merge rules)
  - **Identity fields** (`cpf_encrypted`/`cpf_hash`, `birth_date`, `has_driver_license`, `driver_license_category`): no existing CPF → set directly, no event. Same CPF (hash match) → no-op. Different CPF (hash mismatch) → replace: log a `cpf_replaced` event (hashes only, never the CPF value) and overwrite the three other identity fields together with whatever came in the same write (or null if omitted). `human_locked_fields` does not apply to these fields. (spec, Merge rules)
- CPF is never masked and there is no reveal endpoint — `GET /tasks/:taskId/details` decrypts and returns it in full, protected by the same org-membership check as everything else in that response. (spec, Non-goals — explicit decision)
- `conversation_qualification_events.changed_fields` must never contain a CPF value in any form (plaintext or otherwise) — only field names, hashes, and non-sensitive values. (spec, Architecture)
- `tasks.ai_summary` is written once, at task-creation time, as a snapshot copy of the conversation's qualification `summary` at that moment — it is never read back as a live value anywhere. The panel always reads `conversation_qualifications.summary` via the task's `conversation_id`. (spec, `tasks.ai_summary` section)
- No `conversation_qualification_people` table, no CPF masking format, no reveal endpoint in this pass — explicitly deferred. (spec, Non-goals)
- WhatsApp button: `https://wa.me/<digits with 55 prefix>` only, no `whatsapp://` custom scheme, no pre-filled message. (spec, Frontend)

---

### Task 1: Migration — `conversation_qualifications` + `conversation_qualification_events`

**Files:**
- Create: `supabase/migrations/00020_conversation_qualifications.sql`

**Interfaces:**
- Produces: tables `conversation_qualifications` (columns listed below) and `conversation_qualification_events`, both org-scoped via the generic RLS pattern. Every later task's queries assume these exact column names and types.

Same "no local Supabase CLI, apply manually against the real project" situation as prior migrations in this repo — write the file, verify the SQL is internally consistent, commit. Live application/verification is a manual step outside this environment.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/00020_conversation_qualifications.sql`:

```sql
CREATE TABLE conversation_qualifications (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,

  attendance_type text,
  product_interest text,
  product_model text,
  usage_purpose text,
  city text,
  urgency text,

  sale_amount numeric,
  credit_amount numeric,
  down_payment_amount numeric,
  bid_amount numeric,
  target_installment_amount numeric,
  term_months integer,

  cpf_encrypted text,
  cpf_hash text,
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
CREATE INDEX idx_conversation_qualifications_org ON conversation_qualifications(organization_id);

CREATE TRIGGER trg_conversation_qualifications_updated_at
  BEFORE UPDATE ON conversation_qualifications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE conversation_qualification_events (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_qualification_id uuid NOT NULL REFERENCES conversation_qualifications(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  changed_fields jsonb,
  changed_by_type text NOT NULL,
  changed_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_qualification_events_qualification
  ON conversation_qualification_events(conversation_qualification_id);

ALTER TABLE conversation_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_qualification_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_qualifications_select" ON conversation_qualifications
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "conversation_qualifications_insert" ON conversation_qualifications
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "conversation_qualifications_update" ON conversation_qualifications
  FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "conversation_qualifications_delete" ON conversation_qualifications
  FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()));

CREATE POLICY "conversation_qualification_events_select" ON conversation_qualification_events
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "conversation_qualification_events_insert" ON conversation_qualification_events
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
```

`update_updated_at()` and `get_user_org_ids()` already exist (`supabase/migrations/00009_functions.sql`, `00008_rls_policies.sql:18-21`) — no new helper functions needed. This is the standard org-scoped pattern already used for most tables (`00008_rls_policies.sql:78-105`), not the dedicated-per-user pattern `conversation_reads` needed — this data is shared operational data readable by any org member.

- [ ] **Step 2: Sanity-check the SQL**

Read the file back once with fresh eyes. Confirm: both tables reference real existing tables (`organizations`, `conversations`, `wa_contacts`) with the correct column names; the trigger function and RLS helper function names match what's already defined in earlier migrations (grep `supabase/migrations/*.sql` for `update_updated_at` and `get_user_org_ids` to confirm); no syntax errors (balanced parens, semicolons after every statement).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00020_conversation_qualifications.sql
git commit -m "feat: add conversation_qualifications and conversation_qualification_events tables"
```

---

### Task 2: CPF encryption module

**Files:**
- Create: `packages/database/src/crypto/cpf.ts`
- Test: `packages/database/src/crypto/cpf.test.ts`

**Interfaces:**
- Consumes: `process.env.QUALIFICATION_CPF_ENCRYPTION_KEY` (64 hex chars = 32 bytes), `process.env.QUALIFICATION_CPF_HASH_PEPPER` (any non-empty string).
- Produces: `encryptCpf(plainCpf: string): string`, `decryptCpf(ciphertext: string): string`, `hashCpf(plainCpf: string): string` — all pure functions (deterministic given the same env vars), used by Task 4's `upsertConversationQualification` and Task 6's `GET /tasks/:taskId/details` route.

- [ ] **Step 1: Write the failing tests**

Create `packages/database/src/crypto/cpf.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { encryptCpf, decryptCpf, hashCpf } from "./cpf.js";

beforeAll(() => {
  process.env.QUALIFICATION_CPF_ENCRYPTION_KEY = "0".repeat(64); // 32 bytes of zeros, test-only
  process.env.QUALIFICATION_CPF_HASH_PEPPER = "test-pepper";
});

describe("encryptCpf / decryptCpf", () => {
  it("round-trips a CPF through encryption and decryption", () => {
    const plain = "12345678900";
    const encrypted = encryptCpf(plain);
    expect(encrypted).not.toBe(plain);
    expect(decryptCpf(encrypted)).toBe(plain);
  });

  it("produces a different ciphertext each call (random IV) but both decrypt correctly", () => {
    const plain = "12345678900";
    const a = encryptCpf(plain);
    const b = encryptCpf(plain);
    expect(a).not.toBe(b);
    expect(decryptCpf(a)).toBe(plain);
    expect(decryptCpf(b)).toBe(plain);
  });
});

describe("hashCpf", () => {
  it("hashes the same CPF identically every time", () => {
    expect(hashCpf("12345678900")).toBe(hashCpf("12345678900"));
  });

  it("hashes different CPFs differently", () => {
    expect(hashCpf("12345678900")).not.toBe(hashCpf("98765432100"));
  });

  it("does not return the plain CPF", () => {
    expect(hashCpf("12345678900")).not.toBe("12345678900");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/database && pnpm exec vitest run src/crypto/cpf.test.ts`
Expected: FAIL — `./cpf.js` doesn't exist yet.

- [ ] **Step 3: Write the module**

Create `packages/database/src/crypto/cpf.ts`:

```ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getEncryptionKey(): Buffer {
  const hex = process.env.QUALIFICATION_CPF_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("QUALIFICATION_CPF_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

function getHashPepper(): string {
  const pepper = process.env.QUALIFICATION_CPF_HASH_PEPPER;
  if (!pepper) {
    throw new Error("QUALIFICATION_CPF_HASH_PEPPER must be set");
  }
  return pepper;
}

// Stored as "iv:authTag:ciphertext", each hex-encoded — self-contained, no
// separate columns needed for the IV/auth tag.
export function encryptCpf(plainCpf: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainCpf, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptCpf(stored: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

// HMAC with a pepper distinct from the encryption key, so leaking one
// secret alone doesn't compromise the other. Used to detect a CPF change
// (hash comparison) without ever decrypting.
export function hashCpf(plainCpf: string): string {
  return createHmac("sha256", getHashPepper()).update(plainCpf).digest("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/database && pnpm exec vitest run src/crypto/cpf.test.ts`
Expected: PASS (5 tests).

Then typecheck:

Run: `cd packages/database && pnpm exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/crypto/cpf.ts packages/database/src/crypto/cpf.test.ts
git commit -m "feat: add CPF encryption/hashing module (AES-256-GCM + HMAC-SHA256)"
```

---

### Task 3: Shared types and zod schema

**Files:**
- Create: `packages/shared/src/types/conversation-qualification.ts`
- Modify: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/schemas/conversation-qualification.ts`
- Modify: `packages/shared/src/schemas/index.ts`

**Interfaces:**
- Produces: `ConversationQualification` type, `ConversationQualificationEvent` type, `updateConversationQualificationSchema` (zod, used by Task 6's PATCH route to validate the request body). Every later task imports these from `@aula-agente/shared`.

- [ ] **Step 1: Add the types**

Create `packages/shared/src/types/conversation-qualification.ts`:

```ts
export type AttendanceType = "financing" | "consortium" | "cash" | "workshop";
export type QualificationUrgency = "immediate" | "this_week" | "flexible";

export interface ConversationQualification {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string;

  attendance_type: AttendanceType | null;
  product_interest: string | null;
  product_model: string | null;
  usage_purpose: string | null;
  city: string | null;
  urgency: QualificationUrgency | null;

  sale_amount: number | null;
  credit_amount: number | null;
  down_payment_amount: number | null;
  bid_amount: number | null;
  target_installment_amount: number | null;
  term_months: number | null;

  cpf_encrypted: string | null;
  cpf_hash: string | null;
  birth_date: string | null;
  has_driver_license: boolean | null;
  driver_license_category: string | null;

  summary: string | null;
  next_action: string | null;
  commercial_notes: string | null;

  human_locked_fields: string[];

  created_at: string;
  updated_at: string;
}

export type ConversationQualificationEventType = "field_updated" | "cpf_replaced";

export interface ConversationQualificationEvent {
  id: string;
  organization_id: string;
  conversation_qualification_id: string;
  event_type: ConversationQualificationEventType;
  changed_fields: Record<string, unknown> | null;
  changed_by_type: "human" | "ai";
  changed_by_id: string | null;
  created_at: string;
}

// The subset of ConversationQualification's own fields that a caller may
// write in one call — never id/organization_id/conversation_id/contact_id
// (identity of the row itself) or human_locked_fields (computed internally).
export interface ConversationQualificationWriteFields {
  attendance_type?: AttendanceType | null;
  product_interest?: string | null;
  product_model?: string | null;
  usage_purpose?: string | null;
  city?: string | null;
  urgency?: QualificationUrgency | null;
  sale_amount?: number | null;
  credit_amount?: number | null;
  down_payment_amount?: number | null;
  bid_amount?: number | null;
  target_installment_amount?: number | null;
  term_months?: number | null;
  summary?: string | null;
  next_action?: string | null;
  commercial_notes?: string | null;
}

export interface ConversationQualificationIdentityWrite {
  cpf?: string | null;
  birth_date?: string | null;
  has_driver_license?: boolean | null;
  driver_license_category?: string | null;
}
```

In `packages/shared/src/types/index.ts`, add:

```ts
export * from "./conversation-qualification.js";
```

- [ ] **Step 2: Add the zod schema**

Create `packages/shared/src/schemas/conversation-qualification.ts`:

```ts
import { z } from "zod";

export const updateConversationQualificationSchema = z.object({
  attendance_type: z.enum(["financing", "consortium", "cash", "workshop"]).nullable().optional(),
  product_interest: z.string().max(500).nullable().optional(),
  product_model: z.string().max(500).nullable().optional(),
  usage_purpose: z.string().max(500).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  urgency: z.enum(["immediate", "this_week", "flexible"]).nullable().optional(),
  sale_amount: z.number().nullable().optional(),
  credit_amount: z.number().nullable().optional(),
  down_payment_amount: z.number().nullable().optional(),
  bid_amount: z.number().nullable().optional(),
  target_installment_amount: z.number().nullable().optional(),
  term_months: z.number().int().nullable().optional(),
  summary: z.string().max(5000).nullable().optional(),
  next_action: z.string().max(2000).nullable().optional(),
  commercial_notes: z.string().max(5000).nullable().optional(),
  cpf: z.string().regex(/^\d{11}$/, "CPF deve ter 11 dígitos numéricos").nullable().optional(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  has_driver_license: z.boolean().nullable().optional(),
  driver_license_category: z.string().max(10).nullable().optional(),
});
```

In `packages/shared/src/schemas/index.ts`, add:

```ts
export * from "./conversation-qualification.js";
```

- [ ] **Step 3: Typecheck and build**

Run: `cd packages/shared && pnpm exec tsc --noEmit && pnpm run build`
Expected: no type errors, build succeeds (other packages import from `@aula-agente/shared`'s built `dist/`).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/conversation-qualification.ts packages/shared/src/types/index.ts packages/shared/src/schemas/conversation-qualification.ts packages/shared/src/schemas/index.ts
git commit -m "feat: add ConversationQualification types and update schema"
```

---

### Task 4: `upsertConversationQualification` query + merge-rule pure helpers

**Files:**
- Create: `packages/database/src/queries/conversation-qualification.ts`
- Modify: `packages/database/src/queries/index.ts`
- Test: `packages/database/src/queries/conversation-qualification.test.ts`

**Interfaces:**
- Consumes: `encryptCpf`, `decryptCpf`, `hashCpf` from `./crypto/cpf.js` (Task 2). `ConversationQualification`, `ConversationQualificationWriteFields`, `ConversationQualificationIdentityWrite` from `@aula-agente/shared` (Task 3).
- Produces:
  - `getQualificationByConversationId(client, conversationId): Promise<ConversationQualification | null>` — Task 6's `GET` route and Task 5 both call this.
  - `upsertConversationQualification(client, params: UpsertQualificationParams): Promise<ConversationQualification>` — Task 6's `PATCH` route and Task 7's Helena tool both call this. `UpsertQualificationParams = { organizationId: string; conversationId: string; contactId: string; changedByType: "human" | "ai"; changedById: string | null; fields: ConversationQualificationWriteFields; identity?: ConversationQualificationIdentityWrite }`.
  - Three pure, exported, unit-tested helpers: `computeLockedFields(existingLocked: string[], writtenFields: Record<string, unknown>): string[]`, `filterUnlockedFields<T extends Record<string, unknown>>(fields: T, lockedFields: string[]): Partial<T>`, `decideCpfWriteAction(existingHash: string | null, newHash: string | null): "none" | "set" | "replace"`.

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `packages/database/src/queries/conversation-qualification.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeLockedFields, filterUnlockedFields, decideCpfWriteAction } from "./conversation-qualification.js";

describe("computeLockedFields", () => {
  it("locks a field that is written with a non-null, non-empty value", () => {
    expect(computeLockedFields([], { down_payment_amount: 5000 })).toEqual(["down_payment_amount"]);
  });

  it("keeps existing locked fields not touched by this write", () => {
    expect(computeLockedFields(["city"], { down_payment_amount: 5000 })).toEqual(
      expect.arrayContaining(["city", "down_payment_amount"])
    );
  });

  it("unlocks a field written as null", () => {
    expect(computeLockedFields(["city", "down_payment_amount"], { city: null })).toEqual(["down_payment_amount"]);
  });

  it("unlocks a field written as an empty string", () => {
    expect(computeLockedFields(["city"], { city: "" })).toEqual([]);
  });

  it("re-locking an already-locked field is idempotent (no duplicates)", () => {
    expect(computeLockedFields(["city"], { city: "Goiânia" })).toEqual(["city"]);
  });
});

describe("filterUnlockedFields", () => {
  it("drops fields present in lockedFields", () => {
    expect(filterUnlockedFields({ city: "Goiânia", down_payment_amount: 5000 }, ["city"])).toEqual({
      down_payment_amount: 5000,
    });
  });

  it("passes through fields not in lockedFields unchanged", () => {
    expect(filterUnlockedFields({ city: "Goiânia" }, [])).toEqual({ city: "Goiânia" });
  });

  it("returns an empty object when every field is locked", () => {
    expect(filterUnlockedFields({ city: "Goiânia" }, ["city"])).toEqual({});
  });
});

describe("decideCpfWriteAction", () => {
  it("returns 'none' when no new CPF hash is provided", () => {
    expect(decideCpfWriteAction(null, null)).toBe("none");
    expect(decideCpfWriteAction("existing-hash", null)).toBe("none");
  });

  it("returns 'set' when there is no existing CPF and a new one is provided", () => {
    expect(decideCpfWriteAction(null, "new-hash")).toBe("set");
  });

  it("returns 'none' when the new hash matches the existing one (idempotent resend)", () => {
    expect(decideCpfWriteAction("same-hash", "same-hash")).toBe("none");
  });

  it("returns 'replace' when the new hash differs from the existing one", () => {
    expect(decideCpfWriteAction("old-hash", "new-hash")).toBe("replace");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/database && pnpm exec vitest run src/queries/conversation-qualification.test.ts`
Expected: FAIL — `./conversation-qualification.js` doesn't exist yet.

- [ ] **Step 3: Write the module**

Create `packages/database/src/queries/conversation-qualification.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConversationQualification,
  ConversationQualificationWriteFields,
  ConversationQualificationIdentityWrite,
} from "@aula-agente/shared";
import { encryptCpf, hashCpf } from "../crypto/cpf.js";

export async function getQualificationByConversationId(
  client: SupabaseClient,
  conversationId: string
): Promise<ConversationQualification | null> {
  const { data, error } = await client
    .from("conversation_qualifications")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return data as ConversationQualification | null;
}

// A field counts as "written" (and gets locked) when it's present with a
// real value; writing null or "" un-locks it instead — that's how a human
// hands a field back to Helena.
export function computeLockedFields(existingLocked: string[], writtenFields: Record<string, unknown>): string[] {
  const locked = new Set(existingLocked);
  for (const [key, value] of Object.entries(writtenFields)) {
    if (value === null || value === "") {
      locked.delete(key);
    } else {
      locked.add(key);
    }
  }
  return Array.from(locked);
}

// Helena's write path: silently drop any field a human has already locked,
// rather than erroring — she just doesn't get to touch that field again
// until the human clears it.
export function filterUnlockedFields<T extends Record<string, unknown>>(
  fields: T,
  lockedFields: string[]
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!lockedFields.includes(key)) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export function decideCpfWriteAction(
  existingHash: string | null,
  newHash: string | null
): "none" | "set" | "replace" {
  if (!newHash) return "none";
  if (!existingHash) return "set";
  if (existingHash === newHash) return "none";
  return "replace";
}

export interface UpsertQualificationParams {
  organizationId: string;
  conversationId: string;
  contactId: string;
  changedByType: "human" | "ai";
  changedById: string | null;
  fields: ConversationQualificationWriteFields;
  identity?: ConversationQualificationIdentityWrite;
}

export async function upsertConversationQualification(
  client: SupabaseClient,
  params: UpsertQualificationParams
): Promise<ConversationQualification> {
  const existing = await getQualificationByConversationId(client, params.conversationId);

  // Commercial fields: human writes apply unconditionally and lock;
  // AI writes are filtered against the existing lock list first.
  const commercialWrites =
    params.changedByType === "human"
      ? params.fields
      : filterUnlockedFields(params.fields, existing?.human_locked_fields ?? []);

  const nextLockedFields =
    params.changedByType === "human"
      ? computeLockedFields(existing?.human_locked_fields ?? [], params.fields)
      : existing?.human_locked_fields ?? [];

  // Identity fields: replace-and-audit, independent of human_locked_fields.
  const identityWrites: Record<string, unknown> = {};
  let cpfAction: "none" | "set" | "replace" = "none";
  if (params.identity?.cpf) {
    const newHash = hashCpf(params.identity.cpf);
    cpfAction = decideCpfWriteAction(existing?.cpf_hash ?? null, newHash);
    if (cpfAction === "set" || cpfAction === "replace") {
      identityWrites.cpf_encrypted = encryptCpf(params.identity.cpf);
      identityWrites.cpf_hash = newHash;
      identityWrites.birth_date = params.identity.birth_date ?? null;
      identityWrites.has_driver_license = params.identity.has_driver_license ?? null;
      identityWrites.driver_license_category = params.identity.driver_license_category ?? null;
    }
  }

  const writePayload = {
    ...commercialWrites,
    ...identityWrites,
    human_locked_fields: nextLockedFields,
  };

  let qualification: ConversationQualification;
  if (existing) {
    const { data, error } = await client
      .from("conversation_qualifications")
      .update(writePayload)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw error;
    qualification = data as ConversationQualification;
  } else {
    const { data, error } = await client
      .from("conversation_qualifications")
      .insert({
        organization_id: params.organizationId,
        conversation_id: params.conversationId,
        contact_id: params.contactId,
        ...writePayload,
      })
      .select()
      .single();
    if (error) throw error;
    qualification = data as ConversationQualification;
  }

  const hasCommercialWrites = Object.keys(commercialWrites).length > 0;
  if (hasCommercialWrites) {
    await client.from("conversation_qualification_events").insert({
      organization_id: params.organizationId,
      conversation_qualification_id: qualification.id,
      event_type: "field_updated",
      changed_fields: commercialWrites,
      changed_by_type: params.changedByType,
      changed_by_id: params.changedById,
    });
  }

  if (cpfAction === "replace") {
    await client.from("conversation_qualification_events").insert({
      organization_id: params.organizationId,
      conversation_qualification_id: qualification.id,
      event_type: "cpf_replaced",
      changed_fields: { previous_hash: existing?.cpf_hash ?? null, new_hash: identityWrites.cpf_hash },
      changed_by_type: params.changedByType,
      changed_by_id: params.changedById,
    });
  }

  return qualification;
}
```

In `packages/database/src/queries/index.ts`, add:

```ts
export * from "./conversation-qualification.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/database && pnpm exec vitest run src/queries/conversation-qualification.test.ts`
Expected: PASS (11 tests).

Then typecheck and build:

Run: `cd packages/database && pnpm exec tsc --noEmit && pnpm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/queries/conversation-qualification.ts packages/database/src/queries/conversation-qualification.test.ts packages/database/src/queries/index.ts
git commit -m "feat: add upsertConversationQualification with commercial-lock and CPF-replace merge rules"
```

---

### Task 5: Snapshot the qualification summary into `tasks.ai_summary`

**Files:**
- Modify: `packages/database/src/queries/tasks.ts`

**Interfaces:**
- Consumes: `getQualificationByConversationId` from `./conversation-qualification.js` (Task 4).
- Produces: no new exports — `createTaskWithDedup`'s existing signature and return type are unchanged; only its internal behavior changes (the `ai_summary` it writes is no longer hardcoded `null`).

- [ ] **Step 1: Add the import**

In `packages/database/src/queries/tasks.ts`, add to the top imports:

```ts
import { getQualificationByConversationId } from "./conversation-qualification.js";
```

- [ ] **Step 2: Snapshot the summary before creating a task**

In `createTaskWithDedup`, change:

```ts
  const assigneeType: TaskAssigneeType | null =
    input.assignee_type !== undefined ? input.assignee_type : input.created_by_type === "ai" ? "ai" : null;
  const assigneeId = assigneeType === "human" ? input.assignee_id ?? null : null;

  const task = await createTask(client, {
    organization_id: input.organization_id,
    contact_id: input.contact_id,
    conversation_id: input.conversation_id,
    assignee_type: assigneeType,
    assignee_id: assigneeId,
    type: input.type,
    title: TASK_TYPE_LABELS[input.type],
    description: input.description,
    ai_summary: null,
    reason: input.reason,
    priority: input.priority,
    status: "pending",
    due_date: input.due_date,
    due_time: input.due_time ?? null,
    created_by_type: input.created_by_type,
    created_by_id: input.created_by_id,
  });
```

to:

```ts
  const assigneeType: TaskAssigneeType | null =
    input.assignee_type !== undefined ? input.assignee_type : input.created_by_type === "ai" ? "ai" : null;
  const assigneeId = assigneeType === "human" ? input.assignee_id ?? null : null;

  // One-time photograph of "what we knew when this task was made" — never
  // read back as a live value. The panel always reads the qualification's
  // own summary via conversation_id, not this snapshot.
  const qualification = input.conversation_id
    ? await getQualificationByConversationId(client, input.conversation_id)
    : null;

  const task = await createTask(client, {
    organization_id: input.organization_id,
    contact_id: input.contact_id,
    conversation_id: input.conversation_id,
    assignee_type: assigneeType,
    assignee_id: assigneeId,
    type: input.type,
    title: TASK_TYPE_LABELS[input.type],
    description: input.description,
    ai_summary: qualification?.summary ?? null,
    reason: input.reason,
    priority: input.priority,
    status: "pending",
    due_date: input.due_date,
    due_time: input.due_time ?? null,
    created_by_type: input.created_by_type,
    created_by_id: input.created_by_id,
  });
```

Note: the `decision.action === "update"` branch above this (existing open task gets updated instead of a new one created) is untouched — it doesn't touch `ai_summary` today and this task doesn't change that; the snapshot only happens on genuine task creation.

- [ ] **Step 3: Typecheck**

Run: `cd packages/database && pnpm exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/database/src/queries/tasks.ts
git commit -m "feat: snapshot conversation_qualifications.summary into tasks.ai_summary on creation"
```

---

### Task 6: API routes — `GET /tasks/:taskId/details` and `PATCH /conversations/:conversationId/qualification`

**Files:**
- Modify: `apps/api/src/routes/tasks/index.ts`

**Interfaces:**
- Consumes: `getConversationById` (already exported from `@aula-agente/database`, already joins `wa_contacts(*)` and `agents(name)` — confirmed at `packages/database/src/queries/conversations.ts:34-42`), `getQualificationByConversationId`, `upsertConversationQualification` (Task 4), `decryptCpf` (Task 2), `updateConversationQualificationSchema` (Task 3).
- Produces: no new exports — these are two new route registrations inside the existing `taskRoutes` plugin, already registered in `apps/api/src/server.ts:39` with no path prefix, so no server.ts change is needed.

This file has no existing test coverage for its route handlers (confirmed — only mutation services in `task.service.ts` would be unit-testable, and none are tested today). Verified manually, matching this file's own existing precedent.

- [ ] **Step 1: Add the imports**

In `apps/api/src/routes/tasks/index.ts`, change:

```ts
import type { FastifyInstance } from "fastify";
import { createTaskSchema, updateTaskSchema, rescheduleTaskSchema, cancelTaskSchema } from "@aula-agente/shared";
import { getAdminClient, createTaskWithDedup, getTaskById } from "@aula-agente/database";
```

to:

```ts
import type { FastifyInstance } from "fastify";
import {
  createTaskSchema,
  updateTaskSchema,
  rescheduleTaskSchema,
  cancelTaskSchema,
  updateConversationQualificationSchema,
} from "@aula-agente/shared";
import {
  getAdminClient,
  createTaskWithDedup,
  getTaskById,
  getConversationById,
  getQualificationByConversationId,
  upsertConversationQualification,
} from "@aula-agente/database";
import { decryptCpf } from "@aula-agente/database/crypto/cpf.js";
```

Note on that last import: `packages/database`'s `package.json` only exposes the package root (`main: "./dist/index.js"`), so a deep import like `@aula-agente/database/crypto/cpf.js` will **not** resolve as written. Instead, add `decryptCpf` to `packages/database/src/index.ts`'s exports (it's a small, deliberate exception — CPF decryption should only ever be reachable from `apps/api`, so re-export it explicitly rather than making it available via the general `queries/index.js` wildcard export other query functions use):

```ts
// packages/database/src/index.ts
export { createSupabaseClient } from "./client.js";
export { getAdminClient, type SupabaseClient } from "./admin.js";
export * from "./queries/index.js";
export { decryptCpf } from "./crypto/cpf.js";
```

Then the import in `apps/api/src/routes/tasks/index.ts` becomes simply:

```ts
import { getAdminClient, createTaskWithDedup, getTaskById, getConversationById, getQualificationByConversationId, upsertConversationQualification, decryptCpf } from "@aula-agente/database";
```

- [ ] **Step 2: Add `GET /tasks/:taskId/details`**

In `apps/api/src/routes/tasks/index.ts`, add this route (placed after the existing `GET /organizations/:organizationId/members/display` route, before the `POST /organizations/:organizationId/tasks` route — order among routes in this file doesn't matter functionally, keep it readable):

```ts
  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/details", async (request, reply) => {
    const db = getAdminClient();
    const task = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find((m) => m.organization_id === task.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const conversation = task.conversation_id ? await getConversationById(db, task.conversation_id) : null;
    const qualification = task.conversation_id
      ? await getQualificationByConversationId(db, task.conversation_id)
      : null;

    return {
      task,
      customer: conversation
        ? { id: conversation.wa_contacts.id, name: conversation.wa_contacts.name, phone: conversation.wa_contacts.phone }
        : null,
      conversation: conversation ? { id: conversation.id, lastMessageAt: conversation.last_message_at } : null,
      qualification: qualification
        ? {
            attendance_type: qualification.attendance_type,
            product_interest: qualification.product_interest,
            product_model: qualification.product_model,
            usage_purpose: qualification.usage_purpose,
            city: qualification.city,
            urgency: qualification.urgency,
            sale_amount: qualification.sale_amount,
            credit_amount: qualification.credit_amount,
            down_payment_amount: qualification.down_payment_amount,
            bid_amount: qualification.bid_amount,
            target_installment_amount: qualification.target_installment_amount,
            term_months: qualification.term_months,
            cpf: qualification.cpf_encrypted ? decryptCpf(qualification.cpf_encrypted) : null,
            birth_date: qualification.birth_date,
            has_driver_license: qualification.has_driver_license,
            driver_license_category: qualification.driver_license_category,
            summary: qualification.summary,
            next_action: qualification.next_action,
            commercial_notes: qualification.commercial_notes,
          }
        : null,
    };
  });
```

Three lookups by already-known foreign keys (task → conversation, task → qualification, both by `conversation_id` which is already on `task`) — no N+1, no loop.

**Field naming is deliberately `snake_case` throughout this response** (not `camelCase`) — it matches `updateConversationQualificationSchema` (Task 3) exactly, field for field, so Task 8's frontend can feed a `qualification` object from this `GET` straight into a `PATCH` body with zero key-mapping in between. This is a deliberate consistency choice made while writing this plan (the spec's own example response sketch used camelCase, but that would force an error-prone camelCase↔snake_case translation layer in the frontend for no real benefit).

- [ ] **Step 3: Add `PATCH /conversations/:conversationId/qualification`**

In the same file, add:

```ts
  app.patch<{ Params: { conversationId: string } }>(
    "/conversations/:conversationId/qualification",
    async (request, reply) => {
      const parseResult = updateConversationQualificationSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const conversation = await getConversationById(db, request.params.conversationId);
      const membership = request.user.memberships.find(
        (m) => m.organization_id === conversation.organization_id
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const { cpf, birth_date, has_driver_license, driver_license_category, ...commercialFields } =
        parseResult.data;

      const qualification = await upsertConversationQualification(db, {
        organizationId: conversation.organization_id,
        conversationId: request.params.conversationId,
        contactId: conversation.contact_id,
        changedByType: "human",
        changedById: request.user.id,
        fields: commercialFields,
        identity: cpf !== undefined || birth_date !== undefined || has_driver_license !== undefined || driver_license_category !== undefined
          ? { cpf, birth_date, has_driver_license, driver_license_category }
          : undefined,
      });

      return qualification;
    }
  );
```

- [ ] **Step 4: Run the existing test suite and typecheck**

Run: `cd apps/api && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS, no type errors — this task adds no new tests of its own (route handlers, matches this file's existing untested precedent) but must not break `evolution.test.ts` or any other existing test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tasks/index.ts packages/database/src/index.ts
git commit -m "feat: add GET /tasks/:taskId/details and PATCH /conversations/:conversationId/qualification"
```

---

### Task 7: Helena's `updateConversationQualification` tool

**Files:**
- Create: `packages/agent-runtime/src/tools/update-conversation-qualification.ts`
- Modify: `packages/agent-runtime/src/tools/registry.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/web/src/components/agents/agent-form.tsx`
- Modify: `apps/web/src/components/agents/config/ferramentas-section.tsx`

**Interfaces:**
- Consumes: `upsertConversationQualification` from `@aula-agente/database` (Task 4).
- Produces: `createUpdateConversationQualificationTool(context: { contactId: string; conversationId: string; organizationId: string }): Tool`, registered as `tools.updateQualification` in `buildToolsForAgent` when `toolsConfig.update_qualification` is true.

- [ ] **Step 1: Add the `ToolsConfig` flag**

In `packages/shared/src/types/agent.ts`, change:

```ts
export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
  create_task: boolean;
}
```

to:

```ts
export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
  create_task: boolean;
  update_qualification: boolean;
}
```

- [ ] **Step 2: Write the tool**

Create `packages/agent-runtime/src/tools/update-conversation-qualification.ts`:

```ts
import { tool, type Tool } from "ai";
import { z } from "zod";
import { getAdminClient, upsertConversationQualification } from "@aula-agente/database";

interface UpdateQualificationToolContext {
  contactId: string;
  conversationId: string;
  organizationId: string;
}

export function createUpdateConversationQualificationTool(context: UpdateQualificationToolContext): Tool {
  return tool({
    description:
      "Registra ou atualiza os dados comerciais estruturados desta conversa (produto de interesse, valores, prazo, CPF, dados de financiamento, resumo do atendimento, próxima ação). Use sempre que o cliente informar algo relevante: o que ele quer, quanto pode dar de entrada, valor de parcela desejado, CPF, data de nascimento, se tem CNH. Envie só os campos que você aprendeu agora — não precisa repetir o que já foi dito antes. Se um campo já tiver sido corrigido manualmente por um humano, esta ferramenta simplesmente ignora sua tentativa de mudá-lo, sem erro — não se preocupe com isso. Se o cliente informar um CPF diferente do que já está registrado, isso substitui o anterior automaticamente (normalmente significa que o CPF anterior já foi analisado). Não avise o cliente que você está registrando isso, é interno.",
    inputSchema: z.object({
      attendance_type: z.enum(["financing", "consortium", "cash", "workshop"]).optional(),
      product_interest: z.string().optional(),
      product_model: z.string().optional(),
      usage_purpose: z.string().optional(),
      city: z.string().optional(),
      urgency: z.enum(["immediate", "this_week", "flexible"]).optional(),
      sale_amount: z.number().optional(),
      credit_amount: z.number().optional(),
      down_payment_amount: z.number().optional(),
      bid_amount: z.number().optional(),
      target_installment_amount: z.number().optional(),
      term_months: z.number().int().optional(),
      summary: z.string().describe("Resumo comercial atualizado do atendimento, 2-4 frases").optional(),
      next_action: z.string().optional(),
      commercial_notes: z.string().optional(),
      cpf: z.string().regex(/^\d{11}$/, "11 dígitos numéricos, sem pontuação").optional(),
      birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      has_driver_license: z.boolean().optional(),
      driver_license_category: z.string().optional(),
    }),
    execute: async (input) => {
      try {
        const db = getAdminClient();
        const { cpf, birth_date, has_driver_license, driver_license_category, ...commercialFields } = input;

        await upsertConversationQualification(db, {
          organizationId: context.organizationId,
          conversationId: context.conversationId,
          contactId: context.contactId,
          changedByType: "ai",
          changedById: null,
          fields: commercialFields,
          identity: cpf ? { cpf, birth_date, has_driver_license, driver_license_category } : undefined,
        });

        return "Dados de qualificação atualizados.";
      } catch (err) {
        console.error("updateConversationQualification tool failed:", err);
        return "Não foi possível atualizar os dados de qualificação agora.";
      }
    },
  });
}
```

- [ ] **Step 3: Register the tool (real + mock)**

In `packages/agent-runtime/src/tools/registry.ts`, add the import:

```ts
import { createUpdateConversationQualificationTool } from "./update-conversation-qualification.js";
```

Add the mock tool, next to `createMockCreateTaskTool`:

```ts
function createMockUpdateConversationQualificationTool() {
  return tool({
    description:
      "Simula a atualização de dados de qualificação comercial. Estamos no Playground de testes — nada é gravado de verdade.",
    inputSchema: z.object({
      attendance_type: z.enum(["financing", "consortium", "cash", "workshop"]).optional(),
      summary: z.string().optional(),
    }).passthrough(),
    execute: async () => {
      return "[SIMULADO] Dados de qualificação seriam atualizados agora.";
    },
  });
}
```

In `buildToolsForAgent`, add after the `create_task` block:

```ts
  if (toolsConfig.update_qualification) {
    tools.updateQualification = sandbox
      ? createMockUpdateConversationQualificationTool()
      : createUpdateConversationQualificationTool({ contactId, conversationId, organizationId });
  }
```

- [ ] **Step 4: Add the toggle to the agent config UI**

In `apps/web/src/components/agents/config/ferramentas-section.tsx`, add to `TOOL_ROWS`:

```ts
  { key: "update_qualification", title: "Atualizar dados de qualificação", description: "Permite ao agente registrar automaticamente produto de interesse, valores, CPF e outros dados comerciais durante a conversa" },
```

In `apps/web/src/components/agents/agent-form.tsx`, add a matching `Switch` block after the `create_task` one (around line 199), and add `update_qualification: false` to the default `tools_config` object at line 44:

```ts
      tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: false, create_task: false, update_qualification: false },
```

```tsx
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Atualizar dados de qualificação</p>
              <p className="text-sm text-muted-foreground">Permite ao agente registrar produto de interesse, valores, CPF e outros dados comerciais durante a conversa</p>
            </div>
            <Switch
              checked={form.watch("tools_config.update_qualification")}
              onCheckedChange={(v) => form.setValue("tools_config.update_qualification", v)}
            />
          </div>
```

- [ ] **Step 5: Typecheck and run existing tests**

Run: `cd packages/agent-runtime && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: no type errors, all existing tests pass (this task adds no new tests of its own — the tool mirrors `createCreateTaskTool`, which has none either; it's exercised via `upsertConversationQualification`'s own tests from Task 4).

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: no type errors. Existing agents in the database won't have `update_qualification` in their stored `tools_config` jsonb yet — reading a missing key from that object gives `undefined`, which is falsy, so `buildToolsForAgent`'s `if (toolsConfig.update_qualification)` check safely treats them as "off" with no migration/backfill needed (same as how `create_task` presumably rolled out).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-runtime/src/tools/update-conversation-qualification.ts packages/agent-runtime/src/tools/registry.ts packages/shared/src/types/agent.ts apps/web/src/components/agents/agent-form.tsx apps/web/src/components/agents/config/ferramentas-section.tsx
git commit -m "feat: add Helena's updateConversationQualification tool"
```

---

### Task 8: Frontend — `TaskDetailPanel`, currency helper, WhatsApp button, TaskCard wiring

**Files:**
- Create: `apps/web/src/components/tasks/task-detail-panel.tsx`
- Create: `apps/web/src/components/tasks/qualification-section.tsx`
- Modify: `apps/web/src/lib/utils.ts`
- Modify: `apps/web/src/components/tasks/task-card.tsx`
- Modify: `apps/web/src/components/tasks/task-list.tsx`
- Modify: `apps/web/src/app/(dashboard)/tasks/page.tsx`

**Interfaces:**
- Consumes: `apiFetch` (`@/lib/api`, existing), `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle` (`@/components/ui/sheet`, existing), `formatCurrencyBRL`/`formatPhone` (`@/lib/utils`, Step 1 + existing), `GET /tasks/:taskId/details` and `PATCH /conversations/:conversationId/qualification` (Task 6).
- Produces: `QualificationSection` component + `QualificationFieldDescriptor` type (Step 2), consumed by `TaskDetailPanel` (Step 3). `TaskDetailPanel` component with props `{ taskId: string; onClose: () => void; onTaskChanged: () => void }` — no other file consumes this except the Tasks page (Step 5 below).

This task has no test file — `apps/web` has no test infrastructure (confirmed absent, matches every prior frontend task in this project). Verified manually against the running dev server.

- [ ] **Step 1: Add the currency formatting helper**

In `apps/web/src/lib/utils.ts`, add:

```ts
// Renders a numeric value (or null/undefined, when the field hasn't been
// filled in yet) as Brazilian currency, e.g. 5000 -> "R$ 5.000,00".
export function formatCurrencyBRL(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Não informado";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}
```

- [ ] **Step 2: Write the reusable editable-section component**

Create `apps/web/src/components/tasks/qualification-section.tsx` — one generic component reused for every editable section of the panel (Resumo, Dados do cliente, Informações comerciais, Financiamento), rather than four hand-rolled near-duplicates:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrencyBRL } from "@/lib/utils";

export type QualificationFieldDescriptor =
  | { key: string; label: string; kind: "text" }
  | { key: string; label: string; kind: "textarea" }
  | { key: string; label: string; kind: "number" }
  | { key: string; label: string; kind: "currency" }
  | { key: string; label: string; kind: "date" }
  | { key: string; label: string; kind: "boolean" }
  | { key: string; label: string; kind: "select"; options: Array<{ value: string; label: string }> };

function formatReadValue(field: QualificationFieldDescriptor, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (field.kind === "currency") return formatCurrencyBRL(value as number);
  if (field.kind === "boolean") return value === true ? "Sim" : "Não";
  if (field.kind === "date") return new Date(`${value}T00:00:00`).toLocaleDateString("pt-BR");
  if (field.kind === "select") return field.options.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}

function draftToPatch(fields: QualificationFieldDescriptor[], draft: Record<string, string>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = draft[f.key] ?? "";
    if (f.kind === "number" || f.kind === "currency") {
      patch[f.key] = raw === "" ? null : Number(raw);
    } else if (f.kind === "boolean") {
      patch[f.key] = raw === "" ? null : raw === "true";
    } else {
      patch[f.key] = raw === "" ? null : raw;
    }
  }
  return patch;
}

interface QualificationSectionProps {
  title: string;
  fields: QualificationFieldDescriptor[];
  values: Record<string, unknown>;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}

export function QualificationSection({ title, fields, values, onSave }: QualificationSectionProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    const initial: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key];
      initial[f.key] = v === null || v === undefined ? "" : String(v);
    }
    setDraft(initial);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draftToPatch(fields, draft));
      setEditing(false);
    } catch (err) {
      // Deliberately does NOT setEditing(false) or clear `draft` here — the
      // spec requires a failed save to keep whatever the user typed on
      // screen, not silently discard it.
      alert(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={startEditing}>
            Editar
          </Button>
        )}
      </div>

      {!editing ? (
        <div>
          {fields.map((f) => {
            const display = formatReadValue(f, values[f.key]);
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
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-xs text-muted-foreground">{f.label}</label>
              {f.kind === "textarea" ? (
                <Textarea
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  rows={3}
                />
              ) : f.kind === "select" || f.kind === "boolean" ? (
                <select
                  className="w-full rounded-md border px-2 py-1 text-sm"
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                >
                  <option value="">Não informado</option>
                  {f.kind === "boolean"
                    ? [
                        { value: "true", label: "Sim" },
                        { value: "false", label: "Não" },
                      ].map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))
                    : f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                </select>
              ) : (
                <Input
                  type={f.kind === "number" || f.kind === "currency" ? "number" : f.kind === "date" ? "date" : "text"}
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Salvando..." : "Salvar"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

`Textarea` — check `apps/web/src/components/ui/textarea.tsx` exists (standard shadcn primitive); if this specific project's `ui/` folder doesn't have it yet, that's a small addition of its own (copy the shadcn `textarea` primitive, matching the style of every other file already in `apps/web/src/components/ui/`) before this step can compile.

- [ ] **Step 3: Write the panel component**

Create `apps/web/src/components/tasks/task-detail-panel.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { formatPhone } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { QualificationSection, type QualificationFieldDescriptor } from "./qualification-section";

interface QualificationValues {
  attendance_type: string | null;
  product_interest: string | null;
  product_model: string | null;
  usage_purpose: string | null;
  city: string | null;
  urgency: string | null;
  sale_amount: number | null;
  credit_amount: number | null;
  down_payment_amount: number | null;
  bid_amount: number | null;
  target_installment_amount: number | null;
  term_months: number | null;
  cpf: string | null;
  birth_date: string | null;
  has_driver_license: boolean | null;
  driver_license_category: string | null;
  summary: string | null;
  next_action: string | null;
  commercial_notes: string | null;
}

interface TaskDetails {
  task: {
    id: string;
    status: string;
    priority: string;
    due_date: string;
    due_time: string | null;
    conversation_id: string | null;
  };
  customer: { id: string; name: string | null; phone: string } | null;
  conversation: { id: string; lastMessageAt: string } | null;
  qualification: QualificationValues | null;
}

const EMPTY_QUALIFICATION: QualificationValues = {
  attendance_type: null,
  product_interest: null,
  product_model: null,
  usage_purpose: null,
  city: null,
  urgency: null,
  sale_amount: null,
  credit_amount: null,
  down_payment_amount: null,
  bid_amount: null,
  target_installment_amount: null,
  term_months: null,
  cpf: null,
  birth_date: null,
  has_driver_license: null,
  driver_license_category: null,
  summary: null,
  next_action: null,
  commercial_notes: null,
};

const URGENCY_OPTIONS = [
  { value: "immediate", label: "Imediata" },
  { value: "this_week", label: "Essa semana" },
  { value: "flexible", label: "Flexível" },
];

const ATTENDANCE_TYPE_OPTIONS = [
  { value: "financing", label: "Financiamento" },
  { value: "consortium", label: "Consórcio" },
  { value: "cash", label: "À vista" },
  { value: "workshop", label: "Oficina/peças" },
];

const CLIENT_FIELDS: QualificationFieldDescriptor[] = [
  { key: "attendance_type", label: "Tipo de atendimento", kind: "select", options: ATTENDANCE_TYPE_OPTIONS },
  { key: "city", label: "Cidade", kind: "text" },
  { key: "usage_purpose", label: "Finalidade de uso", kind: "text" },
  { key: "urgency", label: "Urgência", kind: "select", options: URGENCY_OPTIONS },
];

const SUMMARY_FIELDS: QualificationFieldDescriptor[] = [{ key: "summary", label: "Resumo", kind: "textarea" }];

const FINANCING_FIELDS: QualificationFieldDescriptor[] = [
  { key: "cpf", label: "CPF", kind: "text" },
  { key: "birth_date", label: "Nascimento", kind: "date" },
  { key: "has_driver_license", label: "Possui CNH", kind: "boolean" },
  { key: "driver_license_category", label: "Categoria da CNH", kind: "text" },
];

function commercialFields(attendanceType: string | null): QualificationFieldDescriptor[] {
  const base: QualificationFieldDescriptor[] = [
    { key: "product_interest", label: "Produto", kind: "text" },
    { key: "product_model", label: "Modelo", kind: "text" },
    { key: "sale_amount", label: "Valor da venda", kind: "currency" },
  ];
  const financialFields: QualificationFieldDescriptor[] =
    attendanceType === "consortium"
      ? [
          { key: "credit_amount", label: "Crédito desejado", kind: "currency" },
          { key: "bid_amount", label: "Lance", kind: "currency" },
        ]
      : [{ key: "down_payment_amount", label: "Entrada", kind: "currency" }];
  return [
    ...base,
    ...financialFields,
    { key: "target_installment_amount", label: "Parcela desejada", kind: "currency" },
    { key: "term_months", label: "Prazo (meses)", kind: "number" },
    { key: "next_action", label: "Próxima ação", kind: "text" },
    { key: "commercial_notes", label: "Observações", kind: "textarea" },
  ];
}

function openWhatsApp(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const withCountryCode = digits.startsWith("55") ? digits : `55${digits}`;
  window.open(`https://wa.me/${withCountryCode}`, "_blank");
}

interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
  onTaskChanged: () => void;
}

export function TaskDetailPanel({ taskId, onClose, onTaskChanged }: TaskDetailPanelProps) {
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

  const isOpenTask = details ? details.task.status !== "completed" && details.task.status !== "cancelled" : false;
  const qualification = details?.qualification ?? EMPTY_QUALIFICATION;
  const attendanceType = qualification.attendance_type;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{details?.customer?.name || (details?.customer ? formatPhone(details.customer.phone) : "Tarefa")}</SheetTitle>
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
            {details.customer && <p className="text-sm text-muted-foreground">{formatPhone(details.customer.phone)}</p>}

            <div className="flex flex-wrap gap-2">
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
                <Button size="sm" onClick={handleComplete}>
                  Concluir
                </Button>
              )}
            </div>

            <Separator />

            <QualificationSection
              title="Resumo do atendimento"
              fields={SUMMARY_FIELDS}
              values={qualification}
              onSave={handleSaveSection}
            />

            <Separator />

            <QualificationSection
              title="Dados do cliente"
              fields={CLIENT_FIELDS}
              values={qualification}
              onSave={handleSaveSection}
            />
            {details.conversation && (
              <p className="text-xs text-muted-foreground">
                Última interação: {new Date(details.conversation.lastMessageAt).toLocaleString("pt-BR")}
              </p>
            )}

            <Separator />

            <QualificationSection
              title="Informações comerciais"
              fields={commercialFields(attendanceType)}
              values={qualification}
              onSave={handleSaveSection}
            />

            {attendanceType === "financing" && (
              <>
                <Separator />
                <QualificationSection
                  title="Financiamento"
                  fields={FINANCING_FIELDS}
                  values={qualification}
                  onSave={handleSaveSection}
                />
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

Every section — including "Financiamento" — uses the same `QualificationSection` from Step 2, each with its own field list and a shared `handleSaveSection` that `PATCH`es and refetches. `qualification`'s field keys (`attendance_type`, `city`, `cpf`, …) match `updateConversationQualificationSchema` (Task 3) and the `GET` response (Task 6) exactly — no translation layer.

**On "Reagendar"/"Editar"/"Cancelar":** the panel's header only duplicates "Concluir" (the action that most naturally follows "I just did the follow-up"), not the other three. `TaskCard` (Step 4) keeps its full existing action column exactly as it is today, unmodified and fully functional — opening the panel doesn't hide or replace it, it overlays alongside it (the Sheet is `sm:max-w-md`, the task list stays visible to its left). A vendor who needs to reschedule/edit/cancel uses the same buttons on the card they already know, whether or not the panel happens to be open. Wiring those three actions into the panel too is straightforward follow-up work (each one already exists as working code in `task-card.tsx`) but isn't required for this plan's core deliverable.

- [ ] **Step 4: Wire `TaskCard`'s click target**

In `apps/web/src/components/tasks/task-card.tsx`, add an `onOpenDetails: (taskId: string) => void` prop and make the info block (not the actions block) clickable:

```ts
interface TaskCardProps {
  task: TaskWithRelations;
  organizationId: string;
  memberEmailsById: Record<string, string>;
  onRefresh: () => void;
  onOpenDetails: (taskId: string) => void;
}
```

```tsx
export function TaskCard({ task, organizationId, memberEmailsById, onRefresh, onOpenDetails }: TaskCardProps) {
```

Change:

```tsx
      <div className="min-w-0 space-y-1">
```

to:

```tsx
      <div className="min-w-0 cursor-pointer space-y-1" onClick={() => onOpenDetails(task.id)}>
```

`TaskList` (`apps/web/src/components/tasks/task-list.tsx`) passes `onRefresh` down to every `TaskCard` already — add `onOpenDetails` as a new prop threaded the same way (add it to `TaskListProps`, pass it through to each `<TaskCard ... onOpenDetails={onOpenDetails} />` in both the `bucket !== "today"` branch and the hot/warm branches).

- [ ] **Step 5: Wire the panel into the Tasks page**

In `apps/web/src/app/(dashboard)/tasks/page.tsx`, add:

```ts
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";
```

```ts
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
```

Change the `<TaskList ... />` call to pass the new prop:

```tsx
      <TaskList
        tasks={bucketed[tab]}
        bucket={tab}
        organizationId={currentOrg.id}
        memberEmailsById={memberEmailsById}
        onRefresh={fetchTasks}
        onOpenDetails={setSelectedTaskId}
      />

      {selectedTaskId && (
        <TaskDetailPanel
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          onTaskChanged={() => {
            fetchTasks();
            setSelectedTaskId(null);
          }}
        />
      )}
```

This satisfies the "list stays visible, panel overlays, doesn't navigate, filters/tabs/scroll untouched" requirement — `selectedTaskId` is local state layered on top of the existing page, nothing about the existing fetch/bucket/tab logic changes.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/tasks/task-detail-panel.tsx apps/web/src/components/tasks/qualification-section.tsx apps/web/src/lib/utils.ts apps/web/src/components/tasks/task-card.tsx apps/web/src/components/tasks/task-list.tsx "apps/web/src/app/(dashboard)/tasks/page.tsx"
git commit -m "feat: add task detail side panel with per-section editing and WhatsApp button"
```

- [ ] **Step 8: Deploy and verify live**

This feature touches `apps/api` (new routes), `packages/database`/`packages/shared`/`packages/agent-runtime` (rebuilt into both `apps/api` and `apps/worker`), and `apps/web` (new panel) — redeploy `api` and `web` at minimum (`worker` only if this environment's build pipeline requires rebuilding it too for the shared-package changes to take effect there — check how this project's deploy handles workspace package changes before skipping it).

Before any of this works, `QUALIFICATION_CPF_ENCRYPTION_KEY` (64 hex chars) and `QUALIFICATION_CPF_HASH_PEPPER` (any secret string) must be generated and set on the `api` service's environment — without them, any qualification write touching a CPF throws immediately (a clear error, not silent corruption, but nothing works until these are set).

Then verify:
1. Apply Task 1's migration via the Supabase SQL editor (same manual process as prior migrations in this repo).
2. On the Tasks page, click a task with no qualification data yet — confirm the panel opens, shows "Não informado" everywhere, doesn't crash.
3. Edit the summary, save, close and reopen the panel — confirm it persisted.
4. Enable `update_qualification` on a test agent, have a real WhatsApp conversation mention a product/value, confirm a `conversation_qualifications` row appears (check via Supabase Table Editor) and the panel reflects it.
5. Manually edit a field the AI already set, then continue the conversation mentioning a different value for that same field — confirm the AI's new value does NOT overwrite the human-entered one (check `human_locked_fields` on the row).
6. Send a CPF, then a different CPF, in the same test conversation — confirm `conversation_qualification_events` gets a `cpf_replaced` row and the panel shows the newer CPF.
7. Click "WhatsApp" on a task with a real phone number — confirm it opens WhatsApp (app or web) with that contact, without sending anything automatically.
