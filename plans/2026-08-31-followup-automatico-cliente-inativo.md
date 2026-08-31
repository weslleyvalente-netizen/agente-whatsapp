# Followup Automático para Cliente Inativo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer goes quiet after Helena's last message, and there's real commercial-opportunity evidence for that contact, Helena automatically sends up to 2 contextual re-engagement messages (configurable delays), then stops and leaves a note on the existing `customer_unresponsive` task for a human to pick up.

**Architecture:** Extends the existing `stale-conversation-followup` BullMQ worker (`apps/worker/src/workers/stale-conversation-followup.ts`), which today only *creates* a `customer_unresponsive` task and is never acted on. The worker now loops per-agent (reading a new `tools_config.followup_automatico` toggle) instead of per-org, calls the same `runAgent` engine `process-message.ts` uses for normal replies (fed a synthetic system-role "nudge" instead of a real customer message — a small, additive change to `agent-runtime`), and tracks which of the 2 stages already fired via `task_events` rows on the same task (no new tables).

**Tech Stack:** BullMQ `Worker`/`upsertJobScheduler` (existing pattern), Vercel AI SDK `generateText` via `@aula-agente/agent-runtime`'s `runAgent`, Supabase Postgres (existing `tasks`/`task_events`/`messages`/`conversations` tables, no migration), zod (existing `packages/shared/src/schemas`), vitest (existing in `packages/shared`, `packages/agent-runtime`, `apps/worker`), Next.js App Router + shadcn-style UI (existing `apps/web` pattern, no new tests — this repo has no `apps/web` test files at all).

## Global Constraints

- Spec: `specs/2026-08-31-followup-automatico-cliente-inativo-design.md` — read it before starting. This plan implements it with two corrections made during planning (see below).
- **Correction #1 — `conversations.status = 'waiting'` does NOT mean "last message was from Helena."** Verified in code: `status` is set to `'open'` only at conversation creation (`apps/api/src/services/conversation.service.ts`) and to `'waiting'` only after Helena replies (`apps/worker/src/workers/process-message.ts:263`). Nothing ever sets it back to `'open'` when the customer sends a new message — `saveMessage` (`apps/api/src/services/message.service.ts`) only bumps `last_message_at`. So a `'waiting'` conversation where the customer already replied twice looks identical, by `status` alone, to one where Helena is genuinely waiting. This plan derives "Helena spoke last" from the actual most-recent `messages` row (`role === 'agent'`), not from `status`. `getStaleWaitingConversations`'s existing `status='waiting'` filter is kept only as a cheap **prefilter** (fewer rows to check precisely) — never as the correctness signal.
- **Correction #2 — the two follow-up windows are anchored to the customer's last real message, not to `conversations.last_message_at`.** `last_message_at` gets bumped by Helena's own auto-follow-up sends, which would otherwise silently reset the clock and make "23h counted from the original silence, not from the 1st follow-up" (spec, section 1) impossible to implement correctly. The anchor used everywhere below is the `created_at` of the conversation's most recent `role='contact'` message (`getLastContactMessage`, new in Task 2), falling back to `conversations.created_at` if the customer never sent a message (defensive — shouldn't happen given the `hasOpportunitySignalTask` gate, since every opportunity-signal task requires a real conversation to have happened).
- **`followup_automatico` is optional on `ToolsConfig`, not required.** Existing `agents.tools_config` / `agent_configs.tools_config` rows in production don't have this key and won't until someone re-saves/publishes. Every read site falls back to `DEFAULT_FOLLOWUP_AUTOMATICO` (`ativo: false`). No migration, no backfill.
- **The toggle only takes effect once published.** `apps/web/src/components/agents/config/ferramentas-section.tsx` edits the **draft** (`agent_configs.tools_config`); the worker reads the **live** `agents.tools_config`. These only sync via the existing `publish_agent_config` Postgres function (`supabase/migrations/00016_publish_agent_config_function.sql`), unchanged by this plan. This is expected, existing behavior (same as every other Helena setting) — not a bug to fix here.
- **`is_human_takeover = false` and the opportunity-signal gate (`hasOpportunitySignalTask`) are unchanged** — same filters the existing worker already applies. This plan does not widen who gets auto-messaged.
- **Correction #3 — no automated Supabase-backed integration test, despite the spec's Testes section asking for one.** This repo has no real-Supabase test harness anywhere (`packages/database` has no test runner at all, `apps/worker`'s existing tests never touch a live Supabase instance). Adding one would be new test infrastructure, not a to-do this plan can complete inline. Verification is manual instead: Task 6 Step 3 (draft UI round-trip) and the "After implementation" production check with a real test WhatsApp number.
- **Never unit-test a function that does real Supabase/Redis/LLM I/O** — matches this repo's existing convention (`packages/database` has no test runner at all; `agent-runner.test.ts` only tests the pure helpers exported from `agent-runner.ts`, never `runAgent` itself). Every task below extracts decision/formatting logic into a small pure, tested function before wiring it into the impure worker loop.
- **`apps/web` has zero test files in this repo** — Task 6 (UI) has no test steps, only a typecheck + manual verification.
- **Do not run any migration against the linked remote Supabase project.** This plan needs none — every schema change here is either a new (unconstrained) value in an existing free-form/enum TS union backed by a `text` column with no `CHECK`, or a new key in an existing `jsonb` column.
- Follow whatever a neighboring file in the same directory already does — every task below names the exact file to copy the shape of.

---

### Task 1: Shared types, constants, schemas, and the pure stage-decision helper

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/types/task.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/schemas/agent.ts`
- Create: `packages/shared/src/schemas/agent.test.ts`
- Modify: `packages/shared/src/task-helpers.ts`
- Modify: `packages/shared/src/task-helpers.test.ts`

**Interfaces:**
- Produces: `FollowupAutomaticoConfig` (type), `ToolsConfig.followup_automatico?` (field), `DEFAULT_FOLLOWUP_AUTOMATICO` (constant), `TaskEventType` including `"auto_followup_stage_1" | "auto_followup_stage_2"`, `followupAutomaticoConfigSchema` / `toolsConfigSchema` (zod, updated), `decideFollowupStage(params: DecideFollowupStageParams): FollowupStageAction`, `FollowupStageAction = "none" | "send_stage_1" | "send_stage_2"`. All consumed by Task 5 (worker) and Task 6 (UI); `decideFollowupStage`/`FollowupStageAction` consumed only by Task 5.

- [ ] **Step 1: Add `FollowupAutomaticoConfig` and extend `ToolsConfig`**

In `packages/shared/src/types/agent.ts`, replace the file with:

```ts
import type { LLMProvider } from "./organization.js";

export interface Agent {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  provider: LLMProvider;
  temperature: number;
  max_tokens: number;
  tools_config: ToolsConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FollowupAutomaticoConfig {
  ativo: boolean;
  primeiro_followup_horas: number;
  segundo_followup_horas: number;
}

export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
  create_task: boolean;
  // Optional: rows written before this feature shipped don't have this key.
  // Every reader must fall back to DEFAULT_FOLLOWUP_AUTOMATICO.
  followup_automatico?: FollowupAutomaticoConfig;
}
```

- [ ] **Step 2: Add the two new task-event types**

In `packages/shared/src/types/task.ts`, change:

```ts
export type TaskEventType = "created" | "updated" | "rescheduled" | "completed" | "cancelled" | "assigned";
```

to:

```ts
export type TaskEventType =
  | "created"
  | "updated"
  | "rescheduled"
  | "completed"
  | "cancelled"
  | "assigned"
  | "auto_followup_stage_1"
  | "auto_followup_stage_2";
```

- [ ] **Step 3: Add the default constant**

In `packages/shared/src/constants.ts`, right after `DEFAULT_TASK_RULES` (after line 88), add:

```ts

// Used whenever agent.tools_config.followup_automatico is absent (every row
// written before this feature shipped) — see ToolsConfig, FollowupAutomaticoConfig.
export const DEFAULT_FOLLOWUP_AUTOMATICO = {
  ativo: false,
  primeiro_followup_horas: 1,
  segundo_followup_horas: 23,
};
```

- [ ] **Step 4: Write the failing zod schema tests**

Create `packages/shared/src/schemas/agent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { followupAutomaticoConfigSchema, toolsConfigSchema } from "./agent.js";

describe("followupAutomaticoConfigSchema", () => {
  it("defaults to disabled with 1h/23h windows", () => {
    const result = followupAutomaticoConfigSchema.parse({});
    expect(result).toEqual({ ativo: false, primeiro_followup_horas: 1, segundo_followup_horas: 23 });
  });

  it("accepts a custom enabled config", () => {
    const result = followupAutomaticoConfigSchema.parse({
      ativo: true,
      primeiro_followup_horas: 2,
      segundo_followup_horas: 30,
    });
    expect(result).toEqual({ ativo: true, primeiro_followup_horas: 2, segundo_followup_horas: 30 });
  });

  it("rejects a non-positive hours value", () => {
    expect(() => followupAutomaticoConfigSchema.parse({ primeiro_followup_horas: 0 })).toThrow();
  });

  it("rejects an hours value over the 168h (7 day) cap", () => {
    expect(() => followupAutomaticoConfigSchema.parse({ segundo_followup_horas: 200 })).toThrow();
  });
});

describe("toolsConfigSchema", () => {
  it("fills in followup_automatico when the key is absent (legacy rows)", () => {
    const result = toolsConfigSchema.parse({
      search_knowledge: true,
      search_faq: true,
      send_catalog_photo: false,
      create_task: false,
    });
    expect(result.followup_automatico).toEqual({
      ativo: false,
      primeiro_followup_horas: 1,
      segundo_followup_horas: 23,
    });
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm --filter @aula-agente/shared exec vitest run src/schemas/agent.test.ts`
Expected: FAIL — `followupAutomaticoConfigSchema` is not exported yet.

- [ ] **Step 6: Implement the schema**

In `packages/shared/src/schemas/agent.ts`, add (right before `export const toolsConfigSchema = ...`):

```ts
export const followupAutomaticoConfigSchema = z.object({
  ativo: z.boolean().default(false),
  primeiro_followup_horas: z.number().min(0.5).max(168).default(1),
  segundo_followup_horas: z.number().min(0.5).max(168).default(23),
});
```

and change `toolsConfigSchema` to:

```ts
export const toolsConfigSchema = z.object({
  search_knowledge: z.boolean().default(true),
  search_faq: z.boolean().default(true),
  send_catalog_photo: z.boolean().default(false),
  create_task: z.boolean().default(false),
  followup_automatico: followupAutomaticoConfigSchema.default({
    ativo: false,
    primeiro_followup_horas: 1,
    segundo_followup_horas: 23,
  }),
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @aula-agente/shared exec vitest run src/schemas/agent.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 8: Write the failing test for `decideFollowupStage`**

In `packages/shared/src/task-helpers.test.ts`, add at the end of the file:

```ts
describe("decideFollowupStage", () => {
  const base = {
    primeiroFollowupHoras: 1,
    segundoFollowupHoras: 23,
    stage1AlreadySent: false,
    stage2AlreadySent: false,
  };

  it("does nothing before the first window elapses", () => {
    expect(decideFollowupStage({ ...base, hoursSinceCustomerReply: 0.5 })).toBe("none");
  });

  it("sends stage 1 once the first window elapses and stage 1 hasn't fired", () => {
    expect(decideFollowupStage({ ...base, hoursSinceCustomerReply: 1 })).toBe("send_stage_1");
  });

  it("does nothing between stage 1 and the second window", () => {
    expect(
      decideFollowupStage({ ...base, hoursSinceCustomerReply: 5, stage1AlreadySent: true })
    ).toBe("none");
  });

  it("sends stage 2 once the second window elapses and stage 1 already fired", () => {
    expect(
      decideFollowupStage({ ...base, hoursSinceCustomerReply: 23, stage1AlreadySent: true })
    ).toBe("send_stage_2");
  });

  it("never fires again once stage 2 already fired, no matter how many hours pass", () => {
    expect(
      decideFollowupStage({
        ...base,
        hoursSinceCustomerReply: 1000,
        stage1AlreadySent: true,
        stage2AlreadySent: true,
      })
    ).toBe("none");
  });

  it("doesn't crash on a misconfigured second window shorter than the first — fires stage 2 on the very next check after stage 1", () => {
    expect(
      decideFollowupStage({
        hoursSinceCustomerReply: 1,
        primeiroFollowupHoras: 1,
        segundoFollowupHoras: 0.5,
        stage1AlreadySent: true,
        stage2AlreadySent: false,
      })
    ).toBe("send_stage_2");
  });
});
```

- [ ] **Step 9: Run the tests to verify they fail**

Run: `pnpm --filter @aula-agente/shared exec vitest run src/task-helpers.test.ts`
Expected: FAIL — `decideFollowupStage` is not exported yet.

- [ ] **Step 10: Implement `decideFollowupStage`**

In `packages/shared/src/task-helpers.ts`, add at the end of the file:

```ts
export type FollowupStageAction = "none" | "send_stage_1" | "send_stage_2";

export interface DecideFollowupStageParams {
  hoursSinceCustomerReply: number;
  primeiroFollowupHoras: number;
  segundoFollowupHoras: number;
  stage1AlreadySent: boolean;
  stage2AlreadySent: boolean;
}

export function decideFollowupStage(params: DecideFollowupStageParams): FollowupStageAction {
  const {
    hoursSinceCustomerReply,
    primeiroFollowupHoras,
    segundoFollowupHoras,
    stage1AlreadySent,
    stage2AlreadySent,
  } = params;

  if (stage2AlreadySent) return "none";

  if (!stage1AlreadySent) {
    return hoursSinceCustomerReply >= primeiroFollowupHoras ? "send_stage_1" : "none";
  }

  return hoursSinceCustomerReply >= segundoFollowupHoras ? "send_stage_2" : "none";
}
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `pnpm --filter @aula-agente/shared exec vitest run src/task-helpers.test.ts`
Expected: PASS (all existing tests + 6 new ones)

- [ ] **Step 12: Typecheck the whole package and commit**

Run: `pnpm --filter @aula-agente/shared exec tsc --noEmit`
Expected: no errors

```bash
git add packages/shared/src/types/agent.ts packages/shared/src/types/task.ts \
  packages/shared/src/constants.ts packages/shared/src/schemas/agent.ts \
  packages/shared/src/schemas/agent.test.ts packages/shared/src/task-helpers.ts \
  packages/shared/src/task-helpers.test.ts
git commit -m "feat(shared): add followup_automatico config and decideFollowupStage helper"
```

---

### Task 2: Database queries — last contact message, agent-scoped stale conversations

**Files:**
- Modify: `packages/database/src/queries/messages.ts`
- Modify: `packages/database/src/queries/conversations.ts`

**Interfaces:**
- Consumes: none new (plain Supabase client).
- Produces: `getLastContactMessage(client, conversationId): Promise<{ created_at: string } | null>`, `getStaleWaitingConversations(client, organizationId, agentId, cutoffISO): Promise<Array<{ id: string; contact_id: string; created_at: string; last_message_at: string }>>` (signature changed — now takes `agentId` and returns `created_at` too). Both consumed by Task 5.

**No test steps in this task** — `packages/database` has no test runner configured (`package.json` has no `"test"` script and no vitest dependency); every other query in this file is verified the same way, by typecheck + real usage from the worker/API. Task 5 exercises both functions.

- [ ] **Step 1: Add `getLastContactMessage`**

In `packages/database/src/queries/messages.ts`, add after `getRecentMessages` (after line 33):

```ts

export async function getLastContactMessage(client: SupabaseClient, conversationId: string) {
  const { data, error } = await client
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "contact")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as { created_at: string } | null;
}
```

- [ ] **Step 2: Change `getStaleWaitingConversations` to be agent-scoped and return `created_at`**

In `packages/database/src/queries/conversations.ts`, replace:

```ts
export async function getStaleWaitingConversations(
  client: SupabaseClient,
  organizationId: string,
  cutoffISO: string
) {
  const { data, error } = await client
    .from("conversations")
    .select("id, contact_id, last_message_at")
    .eq("organization_id", organizationId)
    .eq("status", "waiting")
    .eq("is_human_takeover", false)
    .lt("last_message_at", cutoffISO);
  if (error) throw error;
  return data as Array<{ id: string; contact_id: string; last_message_at: string }>;
}
```

with:

```ts
export async function getStaleWaitingConversations(
  client: SupabaseClient,
  organizationId: string,
  agentId: string,
  cutoffISO: string
) {
  const { data, error } = await client
    .from("conversations")
    .select("id, contact_id, created_at, last_message_at")
    .eq("organization_id", organizationId)
    .eq("agent_id", agentId)
    .eq("status", "waiting")
    .eq("is_human_takeover", false)
    .lt("last_message_at", cutoffISO);
  if (error) throw error;
  return data as Array<{ id: string; contact_id: string; created_at: string; last_message_at: string }>;
}
```

(This is a prefilter only — see Global Constraints, Correction #1. `status='waiting'` narrows candidates cheaply; Task 5 does the precise check.)

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm --filter @aula-agente/database exec tsc --noEmit`
Expected: no errors (the only caller, `stale-conversation-followup.ts`, is rewritten in Task 5 — until then it still calls the 3-arg form and **will** fail to typecheck standalone; that's expected and fixed by Task 5, done in the same PR/branch before this is ever shipped alone)

```bash
git add packages/database/src/queries/messages.ts packages/database/src/queries/conversations.ts
git commit -m "feat(database): add getLastContactMessage, scope getStaleWaitingConversations to an agent"
```

---

### Task 3: `agent-runtime` — support a synthetic system-role trigger

**Files:**
- Modify: `packages/agent-runtime/src/agent-runner.ts`
- Modify: `packages/agent-runtime/src/agent-runner.test.ts`

**Interfaces:**
- Produces: `buildFinalTurnMessage(currentMessage: Pick<Message, "role" | "content">): ModelMessage` (exported, pure). `runAgent`'s existing signature is unchanged — it now accepts a `currentMessage` with `role: "system"` and treats it as a system turn instead of always injecting it as `role: "user"`.
- Consumed by: Task 5 (worker), which builds a `Message`-shaped object with `role: "system"` instead of a real customer message.

- [ ] **Step 1: Write the failing test**

In `packages/agent-runtime/src/agent-runner.test.ts`, add (near the other small pure-function `describe` blocks):

```ts
describe("buildFinalTurnMessage", () => {
  it("wraps a contact message as a user turn", () => {
    expect(buildFinalTurnMessage({ role: "contact", content: "oi, tudo bem?" })).toEqual({
      role: "user",
      content: "oi, tudo bem?",
    });
  });

  it("wraps an agent message as a user turn too — only 'system' is special-cased", () => {
    expect(buildFinalTurnMessage({ role: "agent", content: "..." })).toEqual({
      role: "user",
      content: "...",
    });
  });

  it("wraps a system-role trigger as a system turn, not a user turn", () => {
    expect(
      buildFinalTurnMessage({ role: "system", content: "cliente sem resposta há 1h" })
    ).toEqual({ role: "system", content: "cliente sem resposta há 1h" });
  });
});
```

And add `buildFinalTurnMessage` to the existing import at the top of the file (`import { formatHistoryForLLM, buildSystemPrompt } from "./agent-runner.js";` becomes `import { formatHistoryForLLM, buildSystemPrompt, buildFinalTurnMessage } from "./agent-runner.js";`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @aula-agente/agent-runtime exec vitest run src/agent-runner.test.ts`
Expected: FAIL — `buildFinalTurnMessage` is not exported yet.

- [ ] **Step 3: Implement `buildFinalTurnMessage` and wire it into `runAgent`**

In `packages/agent-runtime/src/agent-runner.ts`:

1. Add `ModelMessage` to the existing type-only import on line 2:

```ts
import type { LanguageModel, ModelMessage, SystemModelMessage } from "ai";
```

2. Add this function right above `export async function runAgent(...)`:

```ts
// The trigger for a normal reply is always a real customer message — always
// a "user" turn. The stale-conversation follow-up worker (apps/worker) has
// no real customer message to react to; it synthesizes one with
// role: "system" so the model sees an operational instruction ("the
// customer went quiet, decide whether to nudge them") instead of something
// that looks like the customer speaking.
export function buildFinalTurnMessage(currentMessage: Pick<Message, "role" | "content">): ModelMessage {
  if (currentMessage.role === "system") {
    return { role: "system", content: currentMessage.content };
  }
  return { role: "user", content: currentMessage.content };
}
```

3. In `runAgent`, replace:

```ts
    messages: [
      ...history,
      { role: "user", content: currentMessage.content },
    ],
```

with:

```ts
    messages: [...history, buildFinalTurnMessage(currentMessage)],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @aula-agente/agent-runtime exec vitest run src/agent-runner.test.ts`
Expected: PASS (all existing tests + 3 new ones)

- [ ] **Step 5: Run the full package test suite and typecheck**

Run: `pnpm --filter @aula-agente/agent-runtime exec vitest run && pnpm --filter @aula-agente/agent-runtime exec tsc --noEmit`
Expected: PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add packages/agent-runtime/src/agent-runner.ts packages/agent-runtime/src/agent-runner.test.ts
git commit -m "feat(agent-runtime): support a synthetic system-role trigger in runAgent"
```

---

### Task 4: Worker lib — build the re-engagement nudge instruction

**Files:**
- Create: `apps/worker/src/lib/followup-nudge.ts`
- Create: `apps/worker/src/lib/followup-nudge.test.ts`

**Interfaces:**
- Produces: `buildFollowupNudgeInstruction(stage: 1 | 2, hoursSilent: number): string` (pure), `buildFollowupNudgeMessage(params: { conversationId: string; organizationId: string; stage: 1 | 2; hoursSilent: number }): Message` (thin wrapper, not unit-tested — trivial object construction, matches this file's own `buildFollowupNudgeInstruction` for the only thing worth testing).
- Consumed by: Task 5, as the `currentMessage` passed into `runAgent`.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/lib/followup-nudge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFollowupNudgeInstruction } from "./followup-nudge.js";

describe("buildFollowupNudgeInstruction", () => {
  it("stage 1 mentions the elapsed hours and allows the model to opt out", () => {
    const text = buildFollowupNudgeInstruction(1, 1.4);
    expect(text).toContain("1 hora");
    expect(text).toContain("string vazia");
  });

  it("stage 2 says it's the last attempt and allows the model to opt out", () => {
    const text = buildFollowupNudgeInstruction(2, 23.2);
    expect(text).toContain("23 horas");
    expect(text).toContain("última tentativa");
    expect(text).toContain("string vazia");
  });

  it("rounds fractional hours to the nearest whole number", () => {
    expect(buildFollowupNudgeInstruction(1, 1.9)).toContain("2 hora");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aula-agente/worker exec vitest run src/lib/followup-nudge.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/worker/src/lib/followup-nudge.ts`:

```ts
import type { Message } from "@aula-agente/shared";

export function buildFollowupNudgeInstruction(stage: 1 | 2, hoursSilent: number): string {
  const hours = Math.round(hoursSilent);
  const hourWord = hours === 1 ? "1 hora" : `${hours} horas`;

  if (stage === 1) {
    return (
      `O cliente não respondeu à sua última mensagem há mais de ${hourWord}. ` +
      `Se ainda fizer sentido dentro do contexto da conversa, escreva uma mensagem ` +
      `curta e natural pra retomar o contato — sem soar repetitivo ou robótico. ` +
      `Se não fizer sentido insistir agora, responda só com uma string vazia, sem nenhum texto.`
    );
  }

  return (
    `Essa é a sua última tentativa automática de reengajar esse cliente — ele não ` +
    `respondeu nem à sua mensagem anterior, e já se passaram mais de ${hourWord} no ` +
    `total sem resposta. Se ainda fizer sentido, escreva uma mensagem breve e natural ` +
    `tentando retomar o contato pela última vez. Se não fizer sentido insistir, ` +
    `responda só com uma string vazia, sem nenhum texto.`
  );
}

// Message-shaped so it can be passed straight into runAgent's `currentMessage`
// (see packages/agent-runtime's buildFinalTurnMessage) without persisting a
// row — id/created_at are placeholders, never written to the database.
export function buildFollowupNudgeMessage(params: {
  conversationId: string;
  organizationId: string;
  stage: 1 | 2;
  hoursSilent: number;
}): Message {
  return {
    id: "",
    conversation_id: params.conversationId,
    organization_id: params.organizationId,
    evolution_message_id: null,
    role: "system",
    content: buildFollowupNudgeInstruction(params.stage, params.hoursSilent),
    media_url: null,
    media_type: null,
    metadata: null,
    created_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @aula-agente/worker exec vitest run src/lib/followup-nudge.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/followup-nudge.ts apps/worker/src/lib/followup-nudge.test.ts
git commit -m "feat(worker): add followup nudge instruction builder"
```

---

### Task 5: Rewrite the `stale-conversation-followup` worker to send messages

**Files:**
- Modify: `apps/worker/src/workers/stale-conversation-followup.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–4 — `DEFAULT_FOLLOWUP_AUTOMATICO`, `decideFollowupStage`, `FollowupStageAction`, `getAgentsByOrganization`, `getLastContactMessage`, `getStaleWaitingConversations(client, orgId, agentId, cutoffISO)`, `getConversationById`, `getRecentMessages`, `getOpenTaskByConversation`, `getLatestTaskByConversationAndType`, `getTaskEvents`, `hasOpportunitySignalTask`, `createTaskWithDedup`, `updateTask`, `addTaskEvent`, `createMessage`, `resolveApiKey`, `runAgent`, `buildFollowupNudgeMessage`, `acquireConversationLock`/`releaseConversationLock` (`../lib/lock.js`, unchanged), `getSendMessageQueue` (`@aula-agente/queue`, unchanged).
- Produces: nothing new — same exported `startStaleConversationFollowupWorker()` entry point, called the same way from `apps/worker/src/index.ts` (verify in Step 4 that nothing else needs to change there).

**No test steps** — this is the orchestration/I/O layer (BullMQ, Supabase, Redis lock, LLM call, WhatsApp queue). Every decision it makes was already extracted into a tested pure function in Tasks 1–4. Verified by typecheck + the manual production check in Step 5.

- [ ] **Step 1: Check the worker's entry point doesn't need changes**

Run: `grep -n "startStaleConversationFollowupWorker" apps/worker/src/index.ts`
Expected: one line, calling it with no arguments — confirms no signature change needed there.

- [ ] **Step 2: Replace the file**

Replace the full contents of `apps/worker/src/workers/stale-conversation-followup.ts` with:

```ts
import { Worker } from "bullmq";
import {
  QUEUE_NAMES,
  DEFAULT_FOLLOWUP_AUTOMATICO,
  decideFollowupStage,
  toISODateInTimeZone,
} from "@aula-agente/shared";
import type { StaleConversationFollowupJobData } from "@aula-agente/queue";
import { getRedisConnection, getStaleConversationFollowupQueue, getSendMessageQueue } from "@aula-agente/queue";
import {
  getAdminClient,
  getAllOrganizations,
  getAgentsByOrganization,
  getStaleWaitingConversations,
  getConversationById,
  getRecentMessages,
  getLastContactMessage,
  getOpenTaskByConversation,
  getLatestTaskByConversationAndType,
  getTaskEvents,
  hasOpportunitySignalTask,
  createTaskWithDedup,
  updateTask,
  addTaskEvent,
  createMessage,
} from "@aula-agente/database";
import { resolveApiKey, runAgent } from "@aula-agente/agent-runtime";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";
import { buildFollowupNudgeMessage } from "../lib/followup-nudge.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function startStaleConversationFollowupWorker() {
  const worker = new Worker<StaleConversationFollowupJobData>(
    QUEUE_NAMES.STALE_CONVERSATION_FOLLOWUP,
    async () => {
      const db = getAdminClient();
      const organizations = await getAllOrganizations(db);
      let sent = 0;

      for (const org of organizations) {
        const agents = await getAgentsByOrganization(db, org.id);

        for (const agent of agents) {
          if (!agent.is_active) continue;

          const followupConfig = agent.tools_config.followup_automatico ?? DEFAULT_FOLLOWUP_AUTOMATICO;
          if (!followupConfig.ativo) continue;

          const cutoffISO = new Date(
            Date.now() - followupConfig.primeiro_followup_horas * 60 * 60 * 1000
          ).toISOString();

          const staleConversations = await getStaleWaitingConversations(db, org.id, agent.id, cutoffISO);

          for (const conversation of staleConversations) {
            const hasSignal = await hasOpportunitySignalTask(db, org.id, conversation.contact_id);
            if (!hasSignal) continue;

            // Correction #1 (see plan's Global Constraints): only the real
            // last message tells us whether Helena is the one waiting.
            const lastMessages = await getRecentMessages(db, conversation.id, 1);
            const lastMessage = lastMessages[0];
            if (!lastMessage || lastMessage.role !== "agent") continue;

            // Correction #2: anchor the two windows to when the customer
            // actually went quiet, not to last_message_at (which Helena's
            // own follow-up sends would otherwise keep bumping forward).
            const lastContact = await getLastContactMessage(db, conversation.id);
            const anchorISO = lastContact?.created_at ?? conversation.created_at;
            const hoursSilent = (Date.now() - new Date(anchorISO).getTime()) / (1000 * 60 * 60);

            const existingTask = await getLatestTaskByConversationAndType(
              db,
              org.id,
              conversation.id,
              "customer_unresponsive"
            );
            const events = existingTask ? await getTaskEvents(db, existingTask.id) : [];
            const stage1AlreadySent = events.some(
              (e) => e.event_type === "auto_followup_stage_1" && e.created_at > anchorISO
            );
            const stage2AlreadySent = events.some(
              (e) => e.event_type === "auto_followup_stage_2" && e.created_at > anchorISO
            );

            const decision = decideFollowupStage({
              hoursSinceCustomerReply: hoursSilent,
              primeiroFollowupHoras: followupConfig.primeiro_followup_horas,
              segundoFollowupHoras: followupConfig.segundo_followup_horas,
              stage1AlreadySent,
              stage2AlreadySent,
            });

            if (decision === "none") continue;

            // Don't pile a followup message on top of an unrelated open task
            // that's already tracking next steps for this conversation — but
            // only before the customer_unresponsive task itself exists;
            // stage 2 always continues the one stage 1 created.
            if (decision === "send_stage_1" && !existingTask) {
              const otherOpenTask = await getOpenTaskByConversation(db, org.id, conversation.id);
              if (otherOpenTask) continue;
            }

            const stage = decision === "send_stage_1" ? 1 : 2;

            const lockValue = await acquireConversationLock(conversation.id);
            if (!lockValue) continue; // being handled by process-message right now — try again next tick

            try {
              const fullConversation = await getConversationById(db, conversation.id);
              const phone = fullConversation.wa_contacts?.phone;
              if (!phone) continue;

              const apiKey = await resolveApiKey(org.id, agent.provider);
              const history = await getRecentMessages(db, conversation.id, 20);
              const nudge = buildFollowupNudgeMessage({
                conversationId: conversation.id,
                organizationId: org.id,
                stage,
                hoursSilent,
              });

              const result = await runAgent({
                agent,
                messages: history,
                currentMessage: nudge,
                apiKey,
                organizationId: org.id,
                conversationId: conversation.id,
                instanceId: fullConversation.evolution_instance_id,
                phone,
                contactId: conversation.contact_id,
                contactName: fullConversation.wa_contacts?.name ?? null,
              });

              if (result.text.trim()) {
                const responseMessage = await createMessage(db, {
                  conversation_id: conversation.id,
                  organization_id: org.id,
                  evolution_message_id: null,
                  role: "agent",
                  content: result.text,
                  media_url: null,
                  media_type: null,
                  metadata: {
                    model: result.model,
                    input_tokens: result.inputTokens,
                    output_tokens: result.outputTokens,
                    cache_read_tokens: result.cacheReadTokens,
                    cache_write_tokens: result.cacheWriteTokens,
                    cache_status: result.cacheStatus,
                    latency_ms: result.latencyMs,
                    tool_calls: result.toolCalls,
                  },
                });

                await getSendMessageQueue().add("send-message", {
                  conversationId: conversation.id,
                  messageId: responseMessage.id,
                  instanceId: fullConversation.evolution_instance_id,
                  phone,
                  content: result.text,
                  organizationId: org.id,
                });
              }

              const roundedHours = Math.round(hoursSilent);
              const { task } = await createTaskWithDedup(db, {
                organization_id: org.id,
                contact_id: conversation.contact_id,
                conversation_id: conversation.id,
                type: "customer_unresponsive",
                description:
                  stage === 1
                    ? `Cliente parou de responder há mais de ${roundedHours}h — followup automático enviado.`
                    : `Cliente não respondeu nem à 2ª tentativa automática de followup, após mais de ${roundedHours}h de silêncio.`,
                reason: `Sem resposta há mais de ${roundedHours}h`,
                priority: stage === 1 ? "high" : "urgent",
                due_date: toISODateInTimeZone(new Date()),
                created_by_type: "ai",
                created_by_id: null,
              });

              if (stage === 2) {
                await updateTask(db, task.id, { priority: "urgent" });
              }

              await addTaskEvent(db, {
                task_id: task.id,
                organization_id: org.id,
                event_type: stage === 1 ? "auto_followup_stage_1" : "auto_followup_stage_2",
                note: result.text.trim()
                  ? `Followup automático (tentativa ${stage}) enviado ao cliente.`
                  : `Followup automático (tentativa ${stage}): a IA avaliou o contexto e decidiu não enviar mensagem.`,
                created_by_type: "ai",
                created_by_id: null,
              });

              sent++;
            } finally {
              await releaseConversationLock(conversation.id, lockValue);
            }
          }
        }
      }

      if (sent > 0) {
        console.log(`Sent ${sent} automatic followup message(s)`);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );

  const queue = getStaleConversationFollowupQueue();
  queue.upsertJobScheduler(
    "stale-conversation-followup-scheduler",
    { every: CHECK_INTERVAL_MS },
    { name: "check-stale-conversations" }
  );

  worker.on("failed", (job, err) => {
    console.error(`Stale-conversation-followup job ${job?.id} failed:`, err.message);
  });

  console.log("Stale-conversation-followup worker started (runs every 15 min)");
  return worker;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aula-agente/worker exec tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Run the full worker test suite** (nothing here should be affected, this confirms no regression in `process-message.ts`/other workers that share `@aula-agente/database`/`@aula-agente/agent-runtime`)

Run: `pnpm --filter @aula-agente/worker exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/workers/stale-conversation-followup.ts
git commit -m "feat(worker): stale-conversation-followup now sends 2-stage auto followup messages"
```

---

### Task 6: Agent settings UI — liga/desliga + 2 prazos em horas

**Files:**
- Modify: `apps/web/src/components/agents/config/ferramentas-section.tsx`

**Interfaces:**
- Consumes: `FollowupAutomaticoConfig`, `DEFAULT_FOLLOWUP_AUTOMATICO` (from `@aula-agente/shared`), existing `AgentConfigDraft`/`ToolsConfig`/`onPatch` props (unchanged).
- Produces: nothing consumed elsewhere — this is the leaf UI.

No test steps — `apps/web` has no test files anywhere in this repo (see Global Constraints). Verified by typecheck and the manual check in Step 3.

- [ ] **Step 1: Add the card**

In `apps/web/src/components/agents/config/ferramentas-section.tsx`:

1. Add to the imports:

```ts
import { Input } from "@/components/ui/input";
import type { AgentConfigDraft, ToolsConfig, FollowupAutomaticoConfig } from "@aula-agente/shared";
import { DEFAULT_FOLLOWUP_AUTOMATICO } from "@aula-agente/shared";
```

(`AgentConfigDraft, ToolsConfig` were already imported — just add `FollowupAutomaticoConfig` to that same `import type` line, and add the new `import { DEFAULT_FOLLOWUP_AUTOMATICO } from "@aula-agente/shared";` line below it.)

2. Replace the component body with:

```tsx
export function FerramentasSection({ draft, onPatch }: FerramentasSectionProps) {
  const [toolsConfig, setToolsConfig] = useState(draft.tools_config);
  const followup = toolsConfig.followup_automatico ?? DEFAULT_FOLLOWUP_AUTOMATICO;

  const patchFollowup = (next: FollowupAutomaticoConfig) => {
    const nextToolsConfig = { ...toolsConfig, followup_automatico: next };
    setToolsConfig(nextToolsConfig);
    onPatch({ tools_config: nextToolsConfig });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Ferramentas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {TOOL_ROWS.map((row) => (
            <div key={row.key} className="flex items-center justify-between">
              <div>
                <p className="font-medium">{row.title}</p>
                <p className="text-sm text-muted-foreground">{row.description}</p>
              </div>
              <Switch
                checked={toolsConfig[row.key]}
                onCheckedChange={(v) => {
                  const next = { ...toolsConfig, [row.key]: v };
                  setToolsConfig(next);
                  onPatch({ tools_config: next });
                }}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Followup automático</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Reengajar cliente que parou de responder</p>
              <p className="text-sm text-muted-foreground">
                Quando o cliente não responde depois de uma mensagem da Helena, ela tenta
                retomar o contato automaticamente, em até 2 tentativas.
              </p>
            </div>
            <Switch
              checked={followup.ativo}
              onCheckedChange={(v) => patchFollowup({ ...followup, ativo: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>1ª tentativa (horas sem resposta)</Label>
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={followup.primeiro_followup_horas}
                disabled={!followup.ativo}
                onChange={(e) =>
                  patchFollowup({ ...followup, primeiro_followup_horas: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>2ª tentativa (horas sem resposta)</Label>
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={followup.segundo_followup_horas}
                disabled={!followup.ativo}
                onChange={(e) =>
                  patchFollowup({ ...followup, segundo_followup_horas: Number(e.target.value) })
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @aula-agente/web exec tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manual check in the browser**

Run `pnpm dev:web` (uses the live production API and Supabase project — see project convention, this is expected), open the Helena agent's config page, go to "Ferramentas", confirm:
- The new "Followup automático" card renders below the existing tool switches.
- Toggling it on enables the two hour inputs; off disables them (greyed out).
- Changing a value and switching tabs/reloading the draft shows the value persisted (draft auto-saves on every change, same as the other switches on this page).
- This only changes the **draft** — confirm in "Publicar" that publishing is still required before it affects live behavior (Global Constraints).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agents/config/ferramentas-section.tsx
git commit -m "feat(web): add followup automático toggle and hour windows to agent settings"
```

---

## After implementation

- The toggle defaults to **off** everywhere (`DEFAULT_FOLLOWUP_AUTOMATICO.ativo = false`) — turning it on for the real Helena agent requires: editing it in Ferramentas, publishing the config, and confirming (per the spec's Testes section) with a personal test WhatsApp number before any real org relies on it.
- Existing behavior preserved: `hasOpportunitySignalTask` gate, `is_human_takeover` exclusion, the "don't pile on an unrelated open task" check, the 15-minute check interval, and the `customer_unresponsive` task type/dedup mechanism are all unchanged — only the analysis of *when* to act (Corrections #1/#2) and the *action itself* (send a message, not just create a task) are new.
