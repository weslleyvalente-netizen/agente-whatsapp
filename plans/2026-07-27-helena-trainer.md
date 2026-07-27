# Helena Trainer (Fase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Trainer" chat tab to the Central de Configuração where a user asks in natural language for a behavior change to Helena, the Trainer proposes a diff (detecting conflicts/duplication first), and nothing is written to the draft (`agent_configs`) until the user clicks "Aplicar" on that specific proposal.

**Architecture:** Two-stage LLM generation (small classification call, then one focused per-section call only for conflict-free candidates) keeps every `generateObject` schema small enough for Anthropic's structured-output limits. Proposal generation (`trainer.service.ts`) never writes anything; a separate file (`trainer-decisions.service.ts`) is the only place that calls the existing `patchAgentConfig`, reached only from the `/apply` route after an explicit human click. A static test proves that boundary at the source level, the same way `agents-published-fields.test.ts` already proves the `agents`-table boundary.

**Tech Stack:** Fastify (`apps/api`), Next.js App Router (`apps/web`), Supabase/Postgres, Zod, Vercel AI SDK (`generateObject`), Vitest.

## Global Constraints

- Reuse the exact section/item vocabulary already in `apps/web/.../editar/page.tsx`'s `TREE` (`geral`/`personalidade`/`regras`/`conhecimento`/`playbooks`/`ferramentas`) — never invent a new vocabulary.
- The Trainer never calls `patchAgentConfig`, `publishAgentConfig`/`publish_agent_config`, or `.from("agents")` from generation code — only from the explicit-approval write path.
- `generateObject` calls must never receive a schema with more than one full config section's worth of optional fields — Anthropic rejects both ">24 optional parameters" and, even with 0 optional fields, an overly large compiled grammar (see `apps/api/src/services/import-suggestion.service.ts` comment). Reuse its per-section `*GenSchema` constants; never assemble a single call covering multiple sections.
- No new tool/function-calling capability is ever given to a Trainer-facing LLM call (`generateObject` only, no `tools: {...}`).
- `buildConversationPatternContext` must never select `wa_contacts.name`/`wa_contacts.phone` or any `conversation_notes` column, and must regex-redact phone/CPF/e-mail patterns out of message `content` before it reaches a prompt.
- RLS for new tables follows the exact `get_user_org_ids()` / per-table `_select`/`_insert`/`_update`/`_delete` policy pattern in `supabase/migrations/00015_agent_config_rls.sql` — the function itself (defined in `00008_rls_policies.sql`) is not touched.
- Playground, Prompt Builder, Publicar/Descartar keep zero functional change — `PublishDialog` only gains additive item-level detail, `computeChangedSections`'s existing 5-section behavior (identity/personality/rules/knowledge/playbook) is untouched, including its known pre-existing quirk that `tools_config` changes don't move the "Publicar N" badge (true for manual edits today; the Trainer inherits the same behavior for "ferramentas" proposals — not a regression, not in scope to fix here).
- Next migration number is `00017` (last is `00016_publish_agent_config_function.sql`).

---

## File Structure

New files:
- `packages/shared/src/agent-config-sections.ts` — `SectionKey`, `SECTION_ORDER`, `SECTION_ITEMS`, `SECTION_LABELS`, `SECTION_TO_DRAFT_KEY`, `DRAFT_KEY_TO_SECTION`.
- `packages/shared/src/agent-config-sections.test.ts`
- `packages/shared/src/types/agent-trainer.ts` — `TrainerProposal` and friends.
- `packages/shared/src/schemas/agent-trainer.ts` — zod schemas for the LLM output and API bodies.
- `supabase/migrations/00017_agent_trainer.sql`
- `packages/database/src/queries/agent-trainer.ts`
- `apps/api/src/services/trainer.service.ts` — read-only: `proposeConfigChange`, `buildConversationPatternContext`.
- `apps/api/src/services/trainer.service.test.ts`
- `apps/api/src/services/trainer-decisions.service.ts` — the only write path: `applyTrainerProposal`, `rejectTrainerProposal`.
- `apps/api/src/services/trainer-decisions.service.test.ts`
- `apps/api/src/services/trainer-writes.test.ts` — static boundary test.
- `apps/web/src/components/agents/config/use-trainer-session.ts`
- `apps/web/src/components/agents/config/trainer-proposal-card.tsx`
- `apps/web/src/components/agents/config/trainer-panel.tsx`

Modified files:
- `packages/shared/src/agent-config-diff.ts` — add `computeChangedSectionDetails`, export `deepEqual`.
- `packages/shared/src/agent-config-diff.test.ts` — add coverage for the new function.
- `packages/shared/src/index.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/schemas/index.ts` — new barrel exports.
- `packages/database/src/queries/index.ts` — new barrel export.
- `packages/database/src/queries/messages.ts` — add `getRecentMessagesForOrganization`.
- `apps/api/src/services/import-suggestion.service.ts` — no code change, just the source of the reused `identityGenSchema`/`personalityGenSchema`/`rulesGenSchema`/`knowledgeGenSchema`/`playbookGenSchema` exports.
- `apps/api/src/routes/agent-config/index.ts` — 5 new routes.
- `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx` — `TREE` derived from shared constants, 4th tab.
- `apps/web/src/components/agents/config/publish-dialog.tsx` — item-level diff.
- `apps/web/src/components/agents/config/draft-status-bar.tsx` — pass `status` instead of `changedSections`.

---

### Task 1: Shared section vocabulary

**Files:**
- Create: `packages/shared/src/agent-config-sections.ts`
- Create: `packages/shared/src/agent-config-sections.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `SectionKey`, `SECTION_ORDER: readonly SectionKey[]`, `SECTION_ITEMS: Record<SectionKey, Record<string,string> | null>`, `SECTION_LABELS: Record<SectionKey,string>`, `DraftSectionKey`, `SECTION_TO_DRAFT_KEY: Record<SectionKey,DraftSectionKey>`, `DRAFT_KEY_TO_SECTION: Record<DraftSectionKey,SectionKey>` — used by every later task.

- [ ] **Step 1: Write `agent-config-sections.ts`**

```ts
export const SECTION_ORDER = ["geral", "personalidade", "regras", "conhecimento", "playbooks", "ferramentas"] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];

export const SECTION_ITEMS: Record<SectionKey, Record<string, string> | null> = {
  geral: null,
  personalidade: {
    tom_de_voz: "Tom de voz",
    emojis: "Emojis",
    perguntas_por_vez: "Perguntas por vez",
    postura_comercial: "Postura comercial",
    girias: "Gírias proibidas",
    proatividade: "Proatividade",
  },
  regras: {
    transferencia: "Transferência para humano",
    promessas: "Promessas proibidas",
    regras_por_tipo: "Regras por tipo de atendimento",
    preco_desconto: "Preço e desconto",
    objecoes: "Objeções",
  },
  conhecimento: {
    documentos: "Base de Conhecimento",
    faq: "FAQ",
    precos: "Preços",
    links: "Links",
  },
  playbooks: null,
  ferramentas: null,
};

export const SECTION_LABELS: Record<SectionKey, string> = {
  geral: "Geral",
  personalidade: "Personalidade",
  regras: "Regras",
  conhecimento: "Conhecimento",
  playbooks: "Playbooks",
  ferramentas: "Ferramentas",
};

export type DraftSectionKey = "identity" | "personality" | "rules" | "knowledge" | "playbook" | "tools_config";

export const SECTION_TO_DRAFT_KEY: Record<SectionKey, DraftSectionKey> = {
  geral: "identity",
  personalidade: "personality",
  regras: "rules",
  conhecimento: "knowledge",
  playbooks: "playbook",
  ferramentas: "tools_config",
};

export const DRAFT_KEY_TO_SECTION: Record<DraftSectionKey, SectionKey> = {
  identity: "geral",
  personality: "personalidade",
  rules: "regras",
  knowledge: "conhecimento",
  playbook: "playbooks",
  tools_config: "ferramentas",
};
```

- [ ] **Step 2: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { SECTION_ORDER, SECTION_ITEMS, SECTION_LABELS, SECTION_TO_DRAFT_KEY, DRAFT_KEY_TO_SECTION } from "./agent-config-sections.js";

describe("agent-config-sections", () => {
  it("has a label for every section in SECTION_ORDER", () => {
    for (const key of SECTION_ORDER) {
      expect(SECTION_LABELS[key]).toBeTruthy();
    }
  });

  it("has an entry in SECTION_ITEMS for every section (null for sections without items)", () => {
    for (const key of SECTION_ORDER) {
      expect(key in SECTION_ITEMS).toBe(true);
    }
  });

  it("SECTION_TO_DRAFT_KEY and DRAFT_KEY_TO_SECTION are exact inverses of each other", () => {
    for (const key of SECTION_ORDER) {
      const draftKey = SECTION_TO_DRAFT_KEY[key];
      expect(DRAFT_KEY_TO_SECTION[draftKey]).toBe(key);
    }
  });
});
```

- [ ] **Step 3: Export from the package barrel**

In `packages/shared/src/index.ts`, add one line (keep the rest of the file unchanged):

```ts
export * from "./agent-config-sections.js";
```

- [ ] **Step 4: Run the test**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/shared test`
Expected: PASS, including the 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agent-config-sections.ts packages/shared/src/agent-config-sections.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add SectionKey vocabulary shared between the config tree and the Trainer"
```

---

### Task 2: `computeChangedSectionDetails`

**Files:**
- Modify: `packages/shared/src/agent-config-diff.ts`
- Modify: `packages/shared/src/agent-config-diff.test.ts`

**Interfaces:**
- Consumes: `SECTION_ITEMS`, `SECTION_LABELS`, `DRAFT_KEY_TO_SECTION`, `SectionKey` (Task 1).
- Produces: `ChangedSectionDetail`, `computeChangedSectionDetails(draft, baseSnapshot): ChangedSectionDetail[]`, and now-exported `deepEqual` — used by `PublishDialog` (Task 4).

- [ ] **Step 1: Add the failing test first**

Append to `packages/shared/src/agent-config-diff.test.ts` (keep the existing `computeChangedSections` describe block and `baseSections()` helper as-is):

```ts
import { computeChangedSectionDetails } from "./agent-config-diff.js";

describe("computeChangedSectionDetails", () => {
  it("returns every item for every section when there is no base snapshot yet", () => {
    const details = computeChangedSectionDetails(baseSections(), null);
    const personalidade = details.find((d) => d.section === "personalidade");
    expect(personalidade?.items.map((i) => i.key).sort()).toEqual(
      ["emojis", "girias", "perguntas_por_vez", "postura_comercial", "proatividade", "tom_de_voz"].sort()
    );
  });

  it("returns only the item that actually changed within Personalidade", () => {
    const base = baseSections();
    const draft = { ...base, personality: { ...base.personality, proatividade: "novo texto" } };
    expect(computeChangedSectionDetails(draft, base)).toEqual([
      { section: "personalidade", label: "Personalidade", items: [{ key: "proatividade", label: "Proatividade" }] },
    ]);
  });

  it("returns no item breakdown for Geral (a section with no items)", () => {
    const base = baseSections();
    const draft = { ...base, identity: { ...base.identity, nome: "Helena 2.0" } };
    expect(computeChangedSectionDetails(draft, base)).toEqual([{ section: "geral", label: "Geral", items: [] }]);
  });

  it("returns nothing when the draft matches the base snapshot", () => {
    expect(computeChangedSectionDetails(baseSections(), baseSections())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/shared test`
Expected: FAIL — `computeChangedSectionDetails` is not exported yet.

- [ ] **Step 3: Implement it**

Replace the full contents of `packages/shared/src/agent-config-diff.ts` with:

```ts
import type { AgentConfigSections } from "./types/agent-config.js";
import { SECTION_ITEMS, SECTION_LABELS, DRAFT_KEY_TO_SECTION, type SectionKey } from "./agent-config-sections.js";

const SECTION_KEYS = ["identity", "personality", "rules", "knowledge", "playbook"] as const;

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function computeChangedSections(
  draft: AgentConfigSections,
  baseSnapshot: AgentConfigSections | null
): Array<(typeof SECTION_KEYS)[number]> {
  if (!baseSnapshot) return [...SECTION_KEYS];
  return SECTION_KEYS.filter((key) => !deepEqual(draft[key], baseSnapshot[key]));
}

// Bridges each backend section (identity/personality/...) to the UI item
// keys defined in agent-config-sections.ts's SECTION_ITEMS, so the publish
// dialog can show "Personalidade > Emojis" instead of just "Personalidade".
const ITEM_FIELD_MAP: Partial<Record<(typeof SECTION_KEYS)[number], Record<string, string>>> = {
  personality: {
    tom_de_voz: "tom_de_voz",
    emojis: "emojis",
    perguntas_por_vez: "perguntas_por_vez",
    postura_comercial: "postura_comercial",
    girias: "girias_proibidas",
    proatividade: "proatividade",
  },
  rules: {
    transferencia: "transferencia_para_humano",
    promessas: "promessas_proibidas",
    regras_por_tipo: "regras_por_tipo",
    preco_desconto: "preco_desconto",
    objecoes: "objecoes",
  },
  knowledge: {
    documentos: "documentos_ativos",
    faq: "faqs_ativas",
    precos: "precos_notas",
    links: "links",
  },
};

export interface ChangedSectionDetail {
  section: SectionKey;
  label: string;
  items: { key: string; label: string }[];
}

export function computeChangedSectionDetails(
  draft: AgentConfigSections,
  baseSnapshot: AgentConfigSections | null
): ChangedSectionDetail[] {
  const changedDraftKeys = computeChangedSections(draft, baseSnapshot);

  return changedDraftKeys.map((draftKey) => {
    const section = DRAFT_KEY_TO_SECTION[draftKey];
    const label = SECTION_LABELS[section];
    const itemFieldMap = ITEM_FIELD_MAP[draftKey];
    const uiItems = SECTION_ITEMS[section];

    if (!itemFieldMap || !uiItems) return { section, label, items: [] };
    if (!baseSnapshot) {
      return { section, label, items: Object.entries(uiItems).map(([key, itemLabel]) => ({ key, label: itemLabel })) };
    }

    const draftSection = draft[draftKey] as unknown as Record<string, unknown>;
    const baseSection = baseSnapshot[draftKey] as unknown as Record<string, unknown>;
    const items = Object.entries(itemFieldMap)
      .filter(([, fieldKey]) => !deepEqual(draftSection[fieldKey], baseSection[fieldKey]))
      .map(([itemKey]) => ({ key: itemKey, label: uiItems[itemKey] }));

    return { section, label, items };
  });
}
```

- [ ] **Step 4: Run the tests again**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/shared test`
Expected: PASS — both the pre-existing `computeChangedSections` tests and the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agent-config-diff.ts packages/shared/src/agent-config-diff.test.ts
git commit -m "feat(shared): add computeChangedSectionDetails for item-level publish diffs"
```

---

### Task 3: Derive the config tree from the shared vocabulary

**Files:**
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx:19-61`

**Interfaces:**
- Consumes: `SECTION_ORDER`, `SECTION_ITEMS`, `SECTION_LABELS` (Task 1).
- Produces: same `TREE: TreeNode[]` shape and `findLabel` behavior as before — pure relocation, no visual change.

- [ ] **Step 1: Replace the hardcoded `TREE` with one derived from shared constants**

In `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`, add the import:

```ts
import { SECTION_ORDER, SECTION_ITEMS, SECTION_LABELS } from "@aula-agente/shared";
```

Replace lines 19-53 (the hardcoded `const TREE: TreeNode[] = [...]`) with:

```ts
const TREE: TreeNode[] = SECTION_ORDER.map((key) => {
  const items = SECTION_ITEMS[key];
  return items
    ? { type: "group" as const, key, label: SECTION_LABELS[key], items: Object.entries(items).map(([itemKey, label]) => ({ key: itemKey, label })) }
    : { type: "leaf" as const, key, label: SECTION_LABELS[key] };
});
```

Leave `findLabel` (lines 55-61) exactly as-is — it already just reads from `TREE`.

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/web typecheck`
Expected: PASS, no new errors.

- [ ] **Step 3: Manual visual check**

Run: `pnpm --filter @aula-agente/web dev`, open an agent's `editar` page, confirm the left nav tree (Geral/Personalidade/.../Ferramentas, with the same items and order as before) renders identically to before this change.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "refactor(web): derive the config tree from the shared SectionKey vocabulary"
```

---

### Task 4: `PublishDialog` shows item-level detail

**Files:**
- Modify: `apps/web/src/components/agents/config/publish-dialog.tsx`
- Modify: `apps/web/src/components/agents/config/draft-status-bar.tsx:70`

**Interfaces:**
- Consumes: `computeChangedSectionDetails` (Task 2), `AgentConfigStatus` (from `use-agent-config.ts`, unchanged).
- Produces: `PublishDialogProps` now takes `status: AgentConfigStatus` instead of `changedSections: string[]`.

- [ ] **Step 1: Rewrite `publish-dialog.tsx`**

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { computeChangedSectionDetails } from "@aula-agente/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import type { AgentConfigStatus } from "./use-agent-config";

interface PublishDialogProps {
  agentId: string;
  status: AgentConfigStatus;
  onPublished: () => Promise<void>;
}

export function PublishDialog({ agentId, status, onPublished }: PublishDialogProps) {
  const [changelog, setChangelog] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [open, setOpen] = useState(false);

  const details = computeChangedSectionDetails(status.draft, status.latestVersion?.config_snapshot ?? null);

  const handlePublish = async () => {
    setPublishing(true);
    try {
      await apiFetch(`/agents/${agentId}/config/publish`, {
        method: "POST",
        body: JSON.stringify({ changelog }),
      });
      setChangelog("");
      setOpen(false);
      await onPublished();
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button disabled={!status.hasPendingChanges}>Publicar</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publicar alterações</DialogTitle>
          <DialogDescription>Isto atualiza a Helena que atende no WhatsApp agora.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {details.length === 0 && <p className="text-muted-foreground">Nenhuma seção alterada.</p>}
          {details.map((detail) => (
            <div key={detail.section}>
              <p className="font-medium">{detail.label}</p>
              {detail.items.length > 0 && (
                <ul className="ml-4 list-disc text-muted-foreground">
                  {detail.items.map((item) => (
                    <li key={item.key}>{item.label}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <Label>Changelog</Label>
          <Textarea value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="O que mudou e por quê" />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancelar</Button>} />
          <Button onClick={handlePublish} disabled={publishing || !changelog.trim()}>
            {publishing ? "Publicando..." : "Publicar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Update the caller**

In `apps/web/src/components/agents/config/draft-status-bar.tsx:70`, replace:

```tsx
<PublishDialog agentId={agentId} changedSections={status.changedSections} onPublished={onPublished} />
```

with:

```tsx
<PublishDialog agentId={agentId} status={status} onPublished={onPublished} />
```

- [ ] **Step 3: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/web typecheck`
Expected: PASS.

- [ ] **Step 4: Manual check**

In the dev server, edit two fields inside Personalidade (e.g. Emojis and Proatividade) without touching any other section, open "Publicar", and confirm the dialog shows "Personalidade" with exactly those two items listed underneath, not a flat "Personalidade" line.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agents/config/publish-dialog.tsx apps/web/src/components/agents/config/draft-status-bar.tsx
git commit -m "feat(web): show item-level detail in the publish confirmation dialog"
```

---

### Task 5: Shared Trainer types

**Files:**
- Create: `packages/shared/src/types/agent-trainer.ts`
- Modify: `packages/shared/src/types/index.ts`

**Interfaces:**
- Consumes: `SectionKey` (Task 1), `updateAgentConfigSchema` (existing, `packages/shared/src/schemas/agent-config.ts`).
- Produces: `TrainerProposalStatus`, `TrainerConflict`, `TrainerProposalDiffEntry`, `UpdateAgentConfigPatch`, `TrainerProposal`, `AgentTrainerSession`, `AgentTrainerMessage` — used by every later task.

- [ ] **Step 1: Write the file**

```ts
import type { z } from "zod";
import type { SectionKey } from "../agent-config-sections.js";
import type { updateAgentConfigSchema } from "../schemas/agent-config.js";

export type TrainerProposalStatus = "proposed" | "approved" | "rejected" | "applied";

export interface TrainerConflict {
  description: string;
  section: SectionKey;
  item: string | null;
  resolution_options: string[];
}

export interface TrainerProposalDiffEntry {
  field_path: string;
  before: unknown;
  after: unknown;
}

export type UpdateAgentConfigPatch = z.infer<typeof updateAgentConfigSchema>;

export interface TrainerProposal {
  id: string;
  section: SectionKey;
  item: string | null;
  summary: string;
  rationale: string;
  conflicts: TrainerConflict[];
  diff: TrainerProposalDiffEntry[];
  patch: UpdateAgentConfigPatch | null;
  status: TrainerProposalStatus;
}

export interface AgentTrainerSession {
  id: string;
  agent_id: string;
  organization_id: string;
  created_by: string;
  created_at: string;
}

export interface AgentTrainerMessage {
  id: string;
  session_id: string;
  organization_id: string;
  role: "user" | "assistant";
  content: string;
  proposals: TrainerProposal[];
  created_at: string;
}
```

- [ ] **Step 2: Export from the types barrel**

In `packages/shared/src/types/index.ts`, add:

```ts
export * from "./agent-trainer.js";
```

- [ ] **Step 3: Typecheck the package**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/shared typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/agent-trainer.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add TrainerProposal and related types"
```

---

### Task 6: Shared Trainer zod schemas

**Files:**
- Create: `packages/shared/src/schemas/agent-trainer.ts`
- Modify: `packages/shared/src/schemas/index.ts`

**Interfaces:**
- Consumes: `SECTION_ORDER` (Task 1).
- Produces: `sectionKeySchema`, `trainerConflictGenSchema`, `trainerCandidateGenSchema`, `trainerReplyGenSchema` (the stage-1 `generateObject` schema), `sendTrainerMessageSchema` (the `POST .../messages` body schema) — consumed by `trainer.service.ts` (Task 10) and the routes (Task 13).

- [ ] **Step 1: Write the file**

```ts
import { z } from "zod";
import { SECTION_ORDER } from "../agent-config-sections.js";

export const sectionKeySchema = z.enum([...SECTION_ORDER]);

export const trainerConflictGenSchema = z.object({
  description: z.string(),
  resolution_options: z.array(z.string()),
});

export const trainerCandidateGenSchema = z.object({
  section: sectionKeySchema,
  item: z.string().nullable(),
  summary: z.string(),
  rationale: z.string(),
  conflicts: z.array(trainerConflictGenSchema),
});

export const trainerReplyGenSchema = z.object({
  content: z.string(),
  candidates: z.array(trainerCandidateGenSchema),
});

export const sendTrainerMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});
```

- [ ] **Step 2: Export from the schemas barrel**

In `packages/shared/src/schemas/index.ts`, add:

```ts
export * from "./agent-trainer.js";
```

- [ ] **Step 3: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/shared typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/schemas/agent-trainer.ts packages/shared/src/schemas/index.ts
git commit -m "feat(shared): add Trainer zod schemas for generateObject and the message endpoint body"
```

---

### Task 7: Migration `00017_agent_trainer.sql`

**Files:**
- Create: `supabase/migrations/00017_agent_trainer.sql`

**Interfaces:**
- Produces: tables `agent_trainer_sessions`, `agent_trainer_messages` — consumed by `packages/database/src/queries/agent-trainer.ts` (Task 8).

- [ ] **Step 1: Write the migration**

Mirrors `00014_agent_playground.sql` (tables) + `00015_agent_config_rls.sql` (RLS) combined into one file, since this feature adds exactly 2 tables and no other file depends on splitting them:

```sql
CREATE TABLE agent_trainer_sessions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_trainer_messages (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  session_id uuid NOT NULL REFERENCES agent_trainer_sessions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_trainer_sessions_agent ON agent_trainer_sessions(agent_id, created_at DESC);
CREATE INDEX idx_trainer_messages_session ON agent_trainer_messages(session_id, created_at);

ALTER TABLE agent_trainer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_trainer_messages ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['agent_trainer_sessions', 'agent_trainer_messages'] LOOP
    EXECUTE format(
      'CREATE POLICY "%1$s_select" ON %1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_insert" ON %1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_update" ON %1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_delete" ON %1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
  END LOOP;
END $$;
```

- [ ] **Step 2: Apply it**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && npx supabase migration up`
Expected: migration applies cleanly with no errors. If no local Supabase is running yet, use `npx supabase db reset` instead.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00017_agent_trainer.sql
git commit -m "feat(db): add agent_trainer_sessions/messages tables with org-scoped RLS"
```

---

### Task 8: Trainer DB queries

**Files:**
- Create: `packages/database/src/queries/agent-trainer.ts`
- Modify: `packages/database/src/queries/index.ts`

**Interfaces:**
- Consumes: `AgentTrainerSession`, `AgentTrainerMessage`, `TrainerProposal` (Task 5); tables from Task 7.
- Produces: `createTrainerSession`, `getTrainerSessionById`, `getTrainerMessages`, `addTrainerMessage`, `getTrainerMessageByProposalId`, `updateTrainerMessageProposals` — consumed by `trainer.service.ts` (Task 10), `trainer-decisions.service.ts` (Task 11), and the routes (Task 13).

- [ ] **Step 1: Write the file**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTrainerSession, AgentTrainerMessage, TrainerProposal } from "@aula-agente/shared";

export async function createTrainerSession(
  client: SupabaseClient,
  params: { agentId: string; organizationId: string; createdBy: string }
): Promise<AgentTrainerSession> {
  const { data, error } = await client
    .from("agent_trainer_sessions")
    .insert({ agent_id: params.agentId, organization_id: params.organizationId, created_by: params.createdBy })
    .select()
    .single();
  if (error) throw error;
  return data as AgentTrainerSession;
}

export async function getTrainerSessionById(client: SupabaseClient, sessionId: string): Promise<AgentTrainerSession> {
  const { data, error } = await client.from("agent_trainer_sessions").select("*").eq("id", sessionId).single();
  if (error) throw error;
  return data as AgentTrainerSession;
}

export async function getTrainerMessages(client: SupabaseClient, sessionId: string): Promise<AgentTrainerMessage[]> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as AgentTrainerMessage[];
}

export async function addTrainerMessage(
  client: SupabaseClient,
  params: { sessionId: string; organizationId: string; role: "user" | "assistant"; content: string; proposals: TrainerProposal[] }
): Promise<AgentTrainerMessage> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .insert({
      session_id: params.sessionId,
      organization_id: params.organizationId,
      role: params.role,
      content: params.content,
      proposals: params.proposals,
    })
    .select()
    .single();
  if (error) throw error;
  return data as AgentTrainerMessage;
}

// Finds the one message whose `proposals` jsonb array contains an element
// with this id. jsonb `@>` containment matches array elements by partial
// object match, so `[{id: proposalId}]` correctly locates it without
// needing a dedicated proposals table.
export async function getTrainerMessageByProposalId(
  client: SupabaseClient,
  proposalId: string
): Promise<AgentTrainerMessage | null> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .select("*")
    .contains("proposals", [{ id: proposalId }])
    .maybeSingle();
  if (error) throw error;
  return data as AgentTrainerMessage | null;
}

export async function updateTrainerMessageProposals(
  client: SupabaseClient,
  messageId: string,
  proposals: TrainerProposal[]
): Promise<AgentTrainerMessage> {
  const { data, error } = await client
    .from("agent_trainer_messages")
    .update({ proposals })
    .eq("id", messageId)
    .select()
    .single();
  if (error) throw error;
  return data as AgentTrainerMessage;
}
```

- [ ] **Step 2: Export from the queries barrel**

In `packages/database/src/queries/index.ts`, add:

```ts
export * from "./agent-trainer.js";
```

- [ ] **Step 3: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/database typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/database/src/queries/agent-trainer.ts packages/database/src/queries/index.ts
git commit -m "feat(database): add agent_trainer session/message queries"
```

---

### Task 9: Privacy-scoped conversation query

**Files:**
- Modify: `packages/database/src/queries/messages.ts`

**Interfaces:**
- Produces: `getRecentMessagesForOrganization(client, organizationId, { conversationLimit, sinceISO })` — consumed by `buildConversationPatternContext` (Task 10).

- [ ] **Step 1: Add the function**

Append to `packages/database/src/queries/messages.ts` (keep all existing exports untouched):

```ts
// Scoped narrowly for the Trainer's "Analisar conversas reais" flow: only
// role/content/created_at, never wa_contacts.name/phone or conversation_notes,
// and bounded by both a conversation count and a time window.
export async function getRecentMessagesForOrganization(
  client: SupabaseClient,
  organizationId: string,
  params: { conversationLimit: number; sinceISO: string }
): Promise<Array<{ conversation_id: string; role: string; content: string; created_at: string }>> {
  const { data: conversationRows, error: convError } = await client
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .order("last_message_at", { ascending: false })
    .limit(params.conversationLimit);
  if (convError) throw convError;

  const conversationIds = (conversationRows as Array<{ id: string }>).map((c) => c.id);
  if (conversationIds.length === 0) return [];

  const { data, error } = await client
    .from("messages")
    .select("conversation_id, role, content, created_at")
    .in("conversation_id", conversationIds)
    .gte("created_at", params.sinceISO)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Array<{ conversation_id: string; role: string; content: string; created_at: string }>;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/database typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/database/src/queries/messages.ts
git commit -m "feat(database): add privacy-scoped getRecentMessagesForOrganization for the Trainer"
```

---

### Task 10: `trainer.service.ts` — proposal generation (read-only)

**Files:**
- Create: `apps/api/src/services/trainer.service.ts`
- Create: `apps/api/src/services/trainer.service.test.ts`

**Interfaces:**
- Consumes: `identityGenSchema`, `personalityGenSchema`, `rulesGenSchema`, `knowledgeGenSchema`, `playbookGenSchema` (existing exports of `import-suggestion.service.ts`); `SECTION_TO_DRAFT_KEY` (Task 1); `TrainerProposal`, `TrainerProposalDiffEntry` (Task 5); `trainerReplyGenSchema` (Task 6); `getTrainerMessages`, `getRecentMessagesForOrganization` (Tasks 8-9); `getAgentById`, `getOrCreateAgentConfig`, `resolveApiKey`, `createModel`, `updateAgentConfigSchema` (existing).
- Produces: `proposeConfigChange(db, agentId, sessionId, userMessage)`, `buildConversationPatternContext(db, organizationId)`, `redactPii(text)`, `diffSectionValues(before, after, prefix?)` — consumed by the routes (Task 13) and this task's own test.
- **This file must never call `patchAgentConfig`, `publishAgentConfig`, or `.from("agents")`** — enforced by Task 12's static test.

- [ ] **Step 1: Write `trainer.service.ts`**

```ts
import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, getOrCreateAgentConfig, getTrainerMessages, getRecentMessagesForOrganization } from "@aula-agente/database";
import { createModel, resolveApiKey } from "@aula-agente/agent-runtime";
import {
  trainerReplyGenSchema,
  updateAgentConfigSchema,
  SECTION_TO_DRAFT_KEY,
  type SectionKey,
  type TrainerProposal,
  type TrainerProposalDiffEntry,
  type AgentTrainerMessage,
  type AgentConfigDraft,
} from "@aula-agente/shared";
import {
  identityGenSchema,
  personalityGenSchema,
  rulesGenSchema,
  knowledgeGenSchema,
  playbookGenSchema,
} from "./import-suggestion.service.js";

const toolsConfigGenSchema = z.object({
  search_knowledge: z.boolean(),
  search_faq: z.boolean(),
  send_catalog_photo: z.boolean(),
  create_task: z.boolean(),
});

const SECTION_GEN_SCHEMA: Record<SectionKey, z.ZodTypeAny> = {
  geral: identityGenSchema,
  personalidade: personalityGenSchema,
  regras: rulesGenSchema,
  conhecimento: knowledgeGenSchema,
  playbooks: playbookGenSchema,
  ferramentas: toolsConfigGenSchema,
};

const SECTION_GEN_INSTRUCTION: Record<SectionKey, string> = {
  geral: "Atualize a seção identity (nome, função, missão) do agente conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  personalidade:
    "Atualize a seção personality (tom de voz, tamanho de resposta, emojis, perguntas por vez, postura comercial, gírias proibidas, proatividade) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  regras:
    "Atualize a seção rules (transferência para humano, promessas proibidas, regras por tipo de atendimento, preço e desconto, objeções) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  conhecimento: "Atualize a seção knowledge (notas de preço, links, flags de documentos/FAQ ativos) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  playbooks: "Atualize a seção playbook (script de atendimento) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
  ferramentas: "Atualize a seção tools_config (quais ferramentas o agente pode usar) conforme o pedido do usuário, preservando tudo que não deveria mudar.",
};

const PII_PATTERNS = [
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, // CPF
  /\b(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, // phone
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // email
];

export function redactPii(text: string): string {
  return PII_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redigido]"), text);
}

export async function buildConversationPatternContext(db: SupabaseClient, organizationId: string): Promise<string> {
  const sinceISO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const messages = await getRecentMessagesForOrganization(db, organizationId, { conversationLimit: 50, sinceISO });
  return messages.map((m) => `[${m.conversation_id.slice(0, 8)}] ${m.role}: ${redactPii(m.content)}`).join("\n");
}

// Server-computed diff (not authored by the LLM): recurses into plain
// objects, treats arrays as atomic values, and emits one entry per leaf
// that actually changed. Deterministic, so it's safe to trust for display
// even though the "after" value came from the model.
export function diffSectionValues(before: unknown, after: unknown, prefix = ""): TrainerProposalDiffEntry[] {
  const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  if (!isPlainObject(before) || !isPlainObject(after)) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    return [{ field_path: prefix || "(raiz)", before, after }];
  }

  const entries: TrainerProposalDiffEntry[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    entries.push(...diffSectionValues(before[key], after[key], path));
  }
  return entries;
}

function buildStageOnePrompt(params: {
  agentName: string;
  draft: AgentConfigDraft;
  conversationContext: string | null;
  history: AgentTrainerMessage[];
  userMessage: string;
}): string {
  const sections = {
    identity: params.draft.identity,
    personality: params.draft.personality,
    rules: params.draft.rules,
    knowledge: params.draft.knowledge,
    playbook: params.draft.playbook,
    tools_config: params.draft.tools_config,
  };
  const historyLines = params.history.map((m) => `${m.role === "user" ? "Usuário" : "Trainer"}: ${m.content}`).join("\n");

  return [
    `Você é o Trainer da Helena, um agente de atendimento via WhatsApp chamado "${params.agentName}", conversando com o usuário sobre mudanças na configuração dele.`,
    "",
    'Antes de propor qualquer mudança, verifique se ela contradiz ou duplica algo que já existe no rascunho atual. Se contradiz: não gere uma proposta executável — preencha só "conflicts" com a explicação e as opções de resolução, e faça a pergunta ao usuário em "content". Se duplica algo já existente (uma regra, objeção ou item de conhecimento semelhante): aponte a duplicata em vez de propor um item novo. Nunca invente valor de preço, desconto ou condição comercial que o usuário não disse explicitamente — pergunte antes.',
    "",
    "Rascunho atual completo (JSON):",
    JSON.stringify(sections, null, 2),
    ...(params.conversationContext ? ["", "Padrões observados em conversas reais recentes (já sem dados pessoais):", params.conversationContext] : []),
    ...(historyLines ? ["", "Histórico da conversa com o Trainer até agora:", historyLines] : []),
    "",
    `Mensagem nova do usuário: ${params.userMessage}`,
    "",
    'Para cada mudança pedida, gere um item em "candidates" com a seção afetada (geral, personalidade, regras, conhecimento, playbooks ou ferramentas), o item específico dentro dela quando aplicável, um resumo curto, a justificativa, e a lista de conflitos (vazia se não houver). Se a mensagem for só uma pergunta ou não pedir mudança nenhuma, devolva "candidates" vazio e responda em "content".',
  ].join("\n");
}

function buildStageTwoPrompt(section: SectionKey, currentValue: unknown, userMessage: string, candidateSummary: string): string {
  return [
    SECTION_GEN_INSTRUCTION[section],
    "",
    "Valor atual dessa seção (JSON):",
    JSON.stringify(currentValue, null, 2),
    "",
    `Pedido original do usuário: ${userMessage}`,
    `Resumo da mudança já decidida: ${candidateSummary}`,
    "",
    "Devolva o objeto COMPLETO da seção já com a mudança aplicada — inclua também os campos que não mudaram, copiados exatamente como estão.",
  ].join("\n");
}

export async function proposeConfigChange(
  db: SupabaseClient,
  agentId: string,
  sessionId: string,
  userMessage: string
): Promise<{ content: string; proposals: TrainerProposal[] }> {
  const agent = await getAgentById(db, agentId);
  const draft = await getOrCreateAgentConfig(db, agent);
  const history = await getTrainerMessages(db, sessionId);
  const apiKey = await resolveApiKey(agent.organization_id, agent.provider);
  const model = createModel(agent.provider, agent.model, apiKey);

  const conversationContext = /conversa/i.test(userMessage) ? await buildConversationPatternContext(db, agent.organization_id) : null;

  const stageOne = await generateObject({
    model,
    schema: trainerReplyGenSchema,
    prompt: buildStageOnePrompt({ agentName: agent.name, draft, conversationContext, history, userMessage }),
  });

  const proposals: TrainerProposal[] = [];
  for (const candidate of stageOne.object.candidates) {
    if (candidate.conflicts.length > 0) {
      proposals.push({
        id: randomUUID(),
        section: candidate.section,
        item: candidate.item,
        summary: candidate.summary,
        rationale: candidate.rationale,
        conflicts: candidate.conflicts.map((c) => ({ ...c, section: candidate.section, item: candidate.item })),
        diff: [],
        patch: null,
        status: "proposed",
      });
      continue;
    }

    const draftKey = SECTION_TO_DRAFT_KEY[candidate.section];
    const before = draft[draftKey];
    const stageTwo = await generateObject({
      model,
      schema: SECTION_GEN_SCHEMA[candidate.section],
      prompt: buildStageTwoPrompt(candidate.section, before, userMessage, candidate.summary),
    });
    const after = stageTwo.object;
    const patch = updateAgentConfigSchema.parse({ [draftKey]: after });

    proposals.push({
      id: randomUUID(),
      section: candidate.section,
      item: candidate.item,
      summary: candidate.summary,
      rationale: candidate.rationale,
      conflicts: [],
      diff: diffSectionValues(before, after),
      patch,
      status: "proposed",
    });
  }

  return { content: stageOne.object.content, proposals };
}
```

- [ ] **Step 2: Write the test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAgentById, getOrCreateAgentConfig, getTrainerMessages, getRecentMessagesForOrganization, resolveApiKey, createModel } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getOrCreateAgentConfig: vi.fn(),
  getTrainerMessages: vi.fn(),
  getRecentMessagesForOrganization: vi.fn(),
  resolveApiKey: vi.fn(),
  createModel: vi.fn(),
}));
const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("@aula-agente/database", () => ({ getAgentById, getOrCreateAgentConfig, getTrainerMessages, getRecentMessagesForOrganization }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey, createModel }));
vi.mock("ai", () => ({ generateObject }));

import { proposeConfigChange, buildConversationPatternContext, redactPii, diffSectionValues } from "./trainer.service.js";

const baseAgent = {
  id: "agent-1", organization_id: "org-1", name: "Helena", description: "",
  system_prompt: "publicado", model: "gpt-4o-mini", provider: "openai" as const,
  temperature: 0.7, max_tokens: 1024,
  tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
  is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

const baseDraft = {
  id: "config-1", agent_id: "agent-1", organization_id: "org-1", base_version_id: null,
  identity: { nome: "Helena", funcao: "", missao: "" },
  personality: {
    tom_de_voz: "equilibrado" as const, tom_de_voz_personalizado: "", tamanho_resposta: "curta" as const,
    emojis: { ativo: true, maximo: 1, instrucao: "" }, perguntas_por_vez: { maximo: 1 },
    postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "",
  },
  rules: {
    transferencia_para_humano: [], promessas_proibidas: [], regras_por_tipo: [],
    preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" },
    objecoes: [{ id: "a", nome: "Preço alto", como_identificar: "", orientacao: "", pergunta_diagnostico: "", quando_escalar: "", ativo: true }],
  },
  knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
  playbook: { script_atendimento: "" },
  tools_config: baseAgent.tools_config,
  model_settings: { provider: "openai" as const, model: "gpt-4o-mini", temperature: 0.7, max_tokens: 1024 },
  updated_at: "2026-01-01T00:00:00Z", updated_by: null,
};

describe("proposeConfigChange", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    getOrCreateAgentConfig.mockResolvedValue(baseDraft);
    getTrainerMessages.mockResolvedValue([]);
    getRecentMessagesForOrganization.mockResolvedValue([]);
    resolveApiKey.mockResolvedValue("test-key");
    createModel.mockReturnValue("mock-model" as any);
  });

  it("no-conflict scenario: issues a stage-1 and a stage-2 call, and returns a proposal with a full-section patch and a computed diff", async () => {
    generateObject
      .mockResolvedValueOnce({
        object: {
          content: "Vou aumentar o limite de emojis.",
          candidates: [{ section: "personalidade", item: "emojis", summary: "Aumentar emojis de 1 para 3", rationale: "Pedido do usuário", conflicts: [] }],
        },
      })
      .mockResolvedValueOnce({ object: { ...baseDraft.personality, emojis: { ativo: true, maximo: 3, instrucao: "" } } });

    const result = await proposeConfigChange({} as any, "agent-1", "session-1", "deixa até 3 emojis");

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].status).toBe("proposed");
    expect(result.proposals[0].conflicts).toEqual([]);
    expect(result.proposals[0].patch).toEqual({ personality: { ...baseDraft.personality, emojis: { ativo: true, maximo: 3, instrucao: "" } } });
    expect(result.proposals[0].diff).toEqual([{ field_path: "emojis.maximo", before: 1, after: 3 }]);
  });

  it("conflict scenario (perguntas_por_vez=1 + pedido de 3 juntas): stops after stage 1, patch is null, no stage-2 call", async () => {
    generateObject.mockResolvedValueOnce({
      object: {
        content: "Isso contradiz uma regra existente — quer mudar o limite ou manter uma por vez?",
        candidates: [
          {
            section: "personalidade",
            item: "perguntas_por_vez",
            summary: "Perguntar nome, cidade e modelo de uma vez",
            rationale: "Pedido do usuário",
            conflicts: [{ description: "Existe uma regra de 1 pergunta por vez", resolution_options: ["Aumentar o limite para 3", "Manter 1 e reformular o pedido"] }],
          },
        ],
      },
    });

    const result = await proposeConfigChange({} as any, "agent-1", "session-1", "pergunta nome, cidade e modelo de uma vez");

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].patch).toBeNull();
    expect(result.proposals[0].conflicts).toHaveLength(1);
  });

  it("duplication scenario: the stage-1 prompt includes the current objeções list so the model can compare before proposing a new one", async () => {
    generateObject.mockResolvedValueOnce({ object: { content: "Já existe uma objeção parecida.", candidates: [] } });

    await proposeConfigChange({} as any, "agent-1", "session-1", "cliente acha caro");

    const stageOnePrompt = generateObject.mock.calls[0][0].prompt as string;
    expect(stageOnePrompt).toContain("Preço alto");
  });

  it("only fetches conversation-pattern context when the message mentions conversas", async () => {
    generateObject.mockResolvedValue({ object: { content: "ok", candidates: [] } });

    await proposeConfigChange({} as any, "agent-1", "session-1", "ajusta o tom");
    expect(getRecentMessagesForOrganization).not.toHaveBeenCalled();

    await proposeConfigChange({} as any, "agent-1", "session-1", "veja as últimas conversas e sugira melhorias");
    expect(getRecentMessagesForOrganization).toHaveBeenCalledTimes(1);
  });
});

describe("redactPii", () => {
  it("redacts a Brazilian phone number and an email out of free text", () => {
    const text = "meu telefone é (11) 98888-7777 e email joao@example.com";
    const redacted = redactPii(text);
    expect(redacted).not.toContain("98888-7777");
    expect(redacted).not.toContain("joao@example.com");
  });
});

describe("buildConversationPatternContext", () => {
  it("never includes wa_contacts data — only redacted message content", async () => {
    getRecentMessagesForOrganization.mockResolvedValue([
      { conversation_id: "11111111-aaaa", role: "user", content: "meu whatsapp é (21) 99999-1234", created_at: "2026-01-01T00:00:00Z" },
    ]);

    const context = await buildConversationPatternContext({} as any, "org-1");
    expect(context).not.toContain("99999-1234");
  });
});

describe("diffSectionValues", () => {
  it("treats arrays as atomic and only reports leaf primitives that changed", () => {
    const before = { a: 1, nested: { b: "x" }, list: [1, 2] };
    const after = { a: 1, nested: { b: "y" }, list: [1, 2, 3] };
    expect(diffSectionValues(before, after)).toEqual([
      { field_path: "nested.b", before: "x", after: "y" },
      { field_path: "list", before: [1, 2], after: [1, 2, 3] },
    ]);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/api test trainer.service`
Expected: PASS, all scenarios above.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/trainer.service.ts apps/api/src/services/trainer.service.test.ts
git commit -m "feat(api): add proposeConfigChange — read-only, conflict/duplication-aware Trainer generation"
```

---

### Task 11: `trainer-decisions.service.ts` — the only write path

**Files:**
- Create: `apps/api/src/services/trainer-decisions.service.ts`
- Create: `apps/api/src/services/trainer-decisions.service.test.ts`

**Interfaces:**
- Consumes: `getTrainerMessageByProposalId`, `getTrainerSessionById`, `updateTrainerMessageProposals`, `patchAgentConfig` (Task 8 + existing); `TrainerProposal` (Task 5).
- Produces: `applyTrainerProposal(db, agentId, proposalId, updatedBy)`, `rejectTrainerProposal(db, agentId, proposalId)` — consumed by the routes (Task 13).

- [ ] **Step 1: Write the file**

```ts
import type { SupabaseClient } from "@aula-agente/database";
import { getTrainerMessageByProposalId, getTrainerSessionById, updateTrainerMessageProposals, patchAgentConfig } from "@aula-agente/database";
import type { AgentConfigDraft, TrainerProposal } from "@aula-agente/shared";

async function loadOwnedProposal(db: SupabaseClient, agentId: string, proposalId: string): Promise<{ message: Awaited<ReturnType<typeof getTrainerMessageByProposalId>>; proposal: TrainerProposal }> {
  const message = await getTrainerMessageByProposalId(db, proposalId);
  if (!message) throw new Error("Proposal not found");

  const session = await getTrainerSessionById(db, message.session_id);
  if (session.agent_id !== agentId) throw new Error("Proposal does not belong to this agent");

  const proposal = message.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "proposed") throw new Error("Proposal already decided");

  return { message, proposal };
}

export async function applyTrainerProposal(
  db: SupabaseClient,
  agentId: string,
  proposalId: string,
  updatedBy: string
): Promise<{ proposal: TrainerProposal; draft: AgentConfigDraft }> {
  const { message, proposal } = await loadOwnedProposal(db, agentId, proposalId);
  if (proposal.conflicts.length > 0 || !proposal.patch) {
    throw new Error("Cannot apply a proposal with unresolved conflicts");
  }

  const draft = await patchAgentConfig(db, agentId, proposal.patch, updatedBy);

  const appliedProposal: TrainerProposal = { ...proposal, status: "applied" };
  const updatedProposals = message!.proposals.map((p) => (p.id === proposalId ? appliedProposal : p));
  await updateTrainerMessageProposals(db, message!.id, updatedProposals);

  return { proposal: appliedProposal, draft };
}

export async function rejectTrainerProposal(db: SupabaseClient, agentId: string, proposalId: string): Promise<TrainerProposal> {
  const { message, proposal } = await loadOwnedProposal(db, agentId, proposalId);

  const rejectedProposal: TrainerProposal = { ...proposal, status: "rejected" };
  const updatedProposals = message!.proposals.map((p) => (p.id === proposalId ? rejectedProposal : p));
  await updateTrainerMessageProposals(db, message!.id, updatedProposals);

  return rejectedProposal;
}
```

- [ ] **Step 2: Write the test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getTrainerMessageByProposalId, getTrainerSessionById, updateTrainerMessageProposals, patchAgentConfig } = vi.hoisted(() => ({
  getTrainerMessageByProposalId: vi.fn(),
  getTrainerSessionById: vi.fn(),
  updateTrainerMessageProposals: vi.fn(),
  patchAgentConfig: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ getTrainerMessageByProposalId, getTrainerSessionById, updateTrainerMessageProposals, patchAgentConfig }));

import { applyTrainerProposal, rejectTrainerProposal } from "./trainer-decisions.service.js";

const proposal = {
  id: "proposal-1", section: "personalidade" as const, item: "emojis",
  summary: "Aumentar emojis", rationale: "Pedido do usuário", conflicts: [], diff: [],
  patch: { personality: { tom_de_voz: "equilibrado", tom_de_voz_personalizado: "", tamanho_resposta: "curta", emojis: { ativo: true, maximo: 3, instrucao: "" }, perguntas_por_vez: { maximo: 1 }, postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "" } },
  status: "proposed" as const,
};

const message = { id: "message-1", session_id: "session-1", organization_id: "org-1", role: "assistant" as const, content: "ok", proposals: [proposal], created_at: "2026-01-01T00:00:00Z" };
const session = { id: "session-1", agent_id: "agent-1", organization_id: "org-1", created_by: "user-1", created_at: "2026-01-01T00:00:00Z" };

describe("applyTrainerProposal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getTrainerMessageByProposalId.mockResolvedValue(message);
    getTrainerSessionById.mockResolvedValue(session);
    patchAgentConfig.mockResolvedValue({ id: "draft-1" });
    updateTrainerMessageProposals.mockResolvedValue({ ...message, proposals: [{ ...proposal, status: "applied" }] });
  });

  it("calls patchAgentConfig with exactly the proposal's patch and marks it applied", async () => {
    const result = await applyTrainerProposal({} as any, "agent-1", "proposal-1", "user-1");

    expect(patchAgentConfig).toHaveBeenCalledWith({}, "agent-1", proposal.patch, "user-1");
    expect(result.proposal.status).toBe("applied");
    expect(updateTrainerMessageProposals).toHaveBeenCalledWith({}, "message-1", [expect.objectContaining({ id: "proposal-1", status: "applied" })]);
  });

  it("throws and never calls patchAgentConfig when the proposal still has unresolved conflicts", async () => {
    getTrainerMessageByProposalId.mockResolvedValue({
      ...message,
      proposals: [{ ...proposal, conflicts: [{ description: "x", section: "personalidade", item: null, resolution_options: [] }], patch: null }],
    });

    await expect(applyTrainerProposal({} as any, "agent-1", "proposal-1", "user-1")).rejects.toThrow();
    expect(patchAgentConfig).not.toHaveBeenCalled();
  });

  it("throws when the proposal's session does not belong to the given agent", async () => {
    getTrainerSessionById.mockResolvedValue({ ...session, agent_id: "other-agent" });

    await expect(applyTrainerProposal({} as any, "agent-1", "proposal-1", "user-1")).rejects.toThrow();
    expect(patchAgentConfig).not.toHaveBeenCalled();
  });
});

describe("rejectTrainerProposal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getTrainerMessageByProposalId.mockResolvedValue(message);
    getTrainerSessionById.mockResolvedValue(session);
    updateTrainerMessageProposals.mockResolvedValue({ ...message, proposals: [{ ...proposal, status: "rejected" }] });
  });

  it("marks the proposal rejected and never calls patchAgentConfig", async () => {
    const result = await rejectTrainerProposal({} as any, "agent-1", "proposal-1");

    expect(result.status).toBe("rejected");
    expect(patchAgentConfig).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/api test trainer-decisions`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/trainer-decisions.service.ts apps/api/src/services/trainer-decisions.service.test.ts
git commit -m "feat(api): add applyTrainerProposal/rejectTrainerProposal — the Trainer's only write path"
```

---

### Task 12: Static write-boundary test

**Files:**
- Create: `apps/api/src/services/trainer-writes.test.ts`

**Interfaces:**
- Consumes: source of Tasks 10-11 (scans file contents, no imports).

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// proposeConfigChange (trainer.service.ts) must never write anything — it
// only reads the draft and returns proposals for a human to approve. The
// only approved write path is applyTrainerProposal in
// trainer-decisions.service.ts, reached exclusively from the /apply route
// after an explicit human click. This proves that boundary at the source
// level, the same way agents-published-fields.test.ts proves the
// agents-table boundary.

const SERVICES_DIR = path.resolve(__dirname, ".");
const FORBIDDEN_PATTERNS = [
  /patchAgentConfig\s*\(/,
  /publishAgentConfig\s*\(/,
  /publish_agent_config/,
  /\.from\(\s*["'`]agents["'`]\s*\)/,
];

function read(file: string): string {
  return readFileSync(path.join(SERVICES_DIR, file), "utf-8");
}

describe("trainer write boundary", () => {
  it("trainer.service.ts (proposal generation) never writes agent_configs, publishes, or touches agents", () => {
    const content = read("trainer.service.ts");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });

  it("trainer-decisions.service.ts is the only place calling patchAgentConfig for the Trainer, and never publishes", () => {
    const content = read("trainer-decisions.service.ts");
    expect(content.match(/patchAgentConfig\s*\(/g)?.length ?? 0).toBe(1);
    expect(content).not.toMatch(/publishAgentConfig\s*\(/);
    expect(content).not.toMatch(/publish_agent_config/);
    expect(content).not.toMatch(/\.from\(\s*["'`]agents["'`]\s*\)/);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/api test trainer-writes`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/trainer-writes.test.ts
git commit -m "test(api): prove the Trainer has exactly one write path, reachable only from /apply"
```

---

### Task 13: Wire the Trainer HTTP routes

**Files:**
- Modify: `apps/api/src/routes/agent-config/index.ts`

**Interfaces:**
- Consumes: `createTrainerSession`, `getTrainerSessionById`, `getTrainerMessages`, `addTrainerMessage` (Task 8); `proposeConfigChange` (Task 10); `applyTrainerProposal`, `rejectTrainerProposal` (Task 11); `sendTrainerMessageSchema` (Task 6).
- Produces: `POST /agents/:agentId/trainer/sessions`, `GET /agents/:agentId/trainer/sessions/:sessionId/messages`, `POST /agents/:agentId/trainer/sessions/:sessionId/messages`, `POST /agents/:agentId/trainer/proposals/:proposalId/apply`, `POST /agents/:agentId/trainer/proposals/:proposalId/reject` — consumed by `use-trainer-session.ts` (Task 14).

- [ ] **Step 1: Update the imports at the top of `apps/api/src/routes/agent-config/index.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { updateAgentConfigSchema, publishAgentConfigSchema, sendTrainerMessageSchema } from "@aula-agente/shared";
import {
  getAdminClient, getAgentById, patchAgentConfig,
  createPlaygroundSession, getPlaygroundMessages, getPlaygroundSessionById,
  createTrainerSession, getTrainerSessionById, getTrainerMessages, addTrainerMessage,
} from "@aula-agente/database";
import { publishDraft, getAgentConfigWithStatus, discardDraft, listVersions, getVersionWithDiff, restoreVersion } from "../../services/agent-config.service.js";
import { sendPlaygroundMessage } from "../../services/playground.service.js";
import { suggestConfigFromSystemPrompt } from "../../services/import-suggestion.service.js";
import { proposeConfigChange } from "../../services/trainer.service.js";
import { applyTrainerProposal, rejectTrainerProposal } from "../../services/trainer-decisions.service.js";
import { authMiddleware } from "../../middleware/auth.js";
```

- [ ] **Step 2: Append the 5 new routes**

Add these right before the final closing `}` of `agentConfigRoutes`, after the existing `versions/:versionId/restore` route:

```ts
  app.post<{ Params: { agentId: string } }>("/agents/:agentId/trainer/sessions", async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const session = await createTrainerSession(db, {
      agentId: request.params.agentId,
      organizationId: agent.organization_id,
      createdBy: request.user.id,
    });
    return reply.status(201).send(session);
  });

  app.get<{ Params: { agentId: string; sessionId: string } }>(
    "/agents/:agentId/trainer/sessions/:sessionId/messages",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const session = await getTrainerSessionById(db, request.params.sessionId);
      if (session.agent_id !== request.params.agentId) {
        return reply.status(403).send({ error: "Session does not belong to this agent" });
      }

      return getTrainerMessages(db, request.params.sessionId);
    }
  );

  app.post<{ Params: { agentId: string; sessionId: string }; Body: { content: string } }>(
    "/agents/:agentId/trainer/sessions/:sessionId/messages",
    async (request, reply) => {
      const parseResult = sendTrainerMessageSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const session = await getTrainerSessionById(db, request.params.sessionId);
      if (session.agent_id !== request.params.agentId) {
        return reply.status(403).send({ error: "Session does not belong to this agent" });
      }

      const { content, proposals } = await proposeConfigChange(db, request.params.agentId, request.params.sessionId, parseResult.data.content);

      await addTrainerMessage(db, {
        sessionId: request.params.sessionId,
        organizationId: agent.organization_id,
        role: "user",
        content: parseResult.data.content,
        proposals: [],
      });
      const assistantMessage = await addTrainerMessage(db, {
        sessionId: request.params.sessionId,
        organizationId: agent.organization_id,
        role: "assistant",
        content,
        proposals,
      });
      return reply.status(201).send(assistantMessage);
    }
  );

  app.post<{ Params: { agentId: string; proposalId: string } }>(
    "/agents/:agentId/trainer/proposals/:proposalId/apply",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      try {
        const { proposal } = await applyTrainerProposal(db, request.params.agentId, request.params.proposalId, request.user.id);
        return proposal;
      } catch (err) {
        return reply.status(409).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { agentId: string; proposalId: string } }>(
    "/agents/:agentId/trainer/proposals/:proposalId/reject",
    async (request, reply) => {
      const db = getAdminClient();
      const agent = await getAgentById(db, request.params.agentId);
      const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      try {
        const proposal = await rejectTrainerProposal(db, request.params.agentId, request.params.proposalId);
        return proposal;
      } catch (err) {
        return reply.status(409).send({ error: (err as Error).message });
      }
    }
  );
```

- [ ] **Step 3: Typecheck and run the full API test suite**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/api typecheck && pnpm --filter @aula-agente/api test`
Expected: PASS — including `trainer-writes.test.ts`, unaffected by this file since the forbidden patterns are only checked in `trainer.service.ts`/`trainer-decisions.service.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agent-config/index.ts
git commit -m "feat(api): wire the 5 Trainer routes (sessions, messages, apply, reject)"
```

---

### Task 14: `use-trainer-session.ts` hook

**Files:**
- Create: `apps/web/src/components/agents/config/use-trainer-session.ts`

**Interfaces:**
- Consumes: `apiFetch` (`@/lib/api`, existing), `TrainerProposal` (Task 5), routes from Task 13.
- Produces: `TrainerChatMessage`, `useTrainerSession(agentId)` returning `{ messages, sendMessage, sending, decideProposal, pendingProposalsCount }` — consumed by `trainer-panel.tsx` (Task 16) and `editar/page.tsx` (Task 17).

- [ ] **Step 1: Write the file**

```ts
"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { TrainerProposal } from "@aula-agente/shared";

export interface TrainerChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  proposals: TrainerProposal[];
  created_at: string;
}

export function useTrainerSession(agentId: string) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TrainerChatMessage[]>([]);
  const [sending, setSending] = useState(false);

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    const session = (await apiFetch(`/agents/${agentId}/trainer/sessions`, { method: "POST" })) as { id: string };
    setSessionId(session.id);
    return session.id;
  }, [agentId, sessionId]);

  const sendMessage = useCallback(
    async (content: string) => {
      setSending(true);
      try {
        const id = await ensureSession();
        const optimisticUser: TrainerChatMessage = {
          id: `local-${Date.now()}`, session_id: id, role: "user", content, proposals: [], created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimisticUser]);

        const assistantMessage = (await apiFetch(`/agents/${agentId}/trainer/sessions/${id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content }),
        })) as TrainerChatMessage;
        setMessages((prev) => [...prev, assistantMessage]);
      } finally {
        setSending(false);
      }
    },
    [agentId, ensureSession]
  );

  const decideProposal = useCallback(
    async (proposalId: string, decision: "apply" | "reject") => {
      const updated = (await apiFetch(`/agents/${agentId}/trainer/proposals/${proposalId}/${decision}`, { method: "POST" })) as TrainerProposal;
      setMessages((prev) => prev.map((m) => ({ ...m, proposals: m.proposals.map((p) => (p.id === proposalId ? updated : p)) })));
    },
    [agentId]
  );

  const pendingProposalsCount = messages.reduce((count, m) => count + m.proposals.filter((p) => p.status === "proposed").length, 0);

  return { messages, sendMessage, sending, decideProposal, pendingProposalsCount };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/agents/config/use-trainer-session.ts
git commit -m "feat(web): add useTrainerSession hook"
```

---

### Task 15: `trainer-proposal-card.tsx`

**Files:**
- Create: `apps/web/src/components/agents/config/trainer-proposal-card.tsx`

**Interfaces:**
- Consumes: `TrainerProposal` (Task 5); `decideProposal` (Task 14).
- Produces: `TrainerProposalCard` — consumed by `trainer-panel.tsx` (Task 16).

- [ ] **Step 1: Write the file**

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { TrainerProposal } from "@aula-agente/shared";

interface TrainerProposalCardProps {
  proposal: TrainerProposal;
  onDecide: (proposalId: string, decision: "apply" | "reject") => Promise<void>;
}

export function TrainerProposalCard({ proposal, onDecide }: TrainerProposalCardProps) {
  const [deciding, setDeciding] = useState(false);

  const handleDecide = async (decision: "apply" | "reject") => {
    setDeciding(true);
    try {
      await onDecide(proposal.id, decision);
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div className="rounded-md border bg-background p-3 text-sm text-foreground">
      <p className="font-medium">{proposal.summary}</p>
      <p className="mt-1 text-muted-foreground">{proposal.rationale}</p>

      {proposal.conflicts.length > 0 && (
        <div className="mt-2 space-y-2 rounded-md bg-amber-50 p-2 dark:bg-amber-950">
          {proposal.conflicts.map((conflict, i) => (
            <div key={i}>
              <p className="text-amber-800 dark:text-amber-200">{conflict.description}</p>
              <ul className="ml-4 list-disc text-xs text-amber-700 dark:text-amber-300">
                {conflict.resolution_options.map((option, j) => (
                  <li key={j}>{option}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {proposal.diff.length > 0 && (
        <div className="mt-2 space-y-1 border-t pt-2">
          {proposal.diff.map((entry, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">{entry.field_path}:</span>
              <span className="line-through opacity-60">{JSON.stringify(entry.before)}</span>
              <span>→</span>
              <span className="font-medium">{JSON.stringify(entry.after)}</span>
            </div>
          ))}
        </div>
      )}

      {proposal.status === "proposed" && proposal.conflicts.length === 0 && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => handleDecide("apply")} disabled={deciding}>
            Aplicar
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleDecide("reject")} disabled={deciding}>
            Rejeitar
          </Button>
        </div>
      )}

      {proposal.status === "applied" && (
        <Badge className="mt-3" variant="default">
          Aplicada
        </Badge>
      )}
      {proposal.status === "rejected" && (
        <Badge className="mt-3" variant="secondary">
          Rejeitada
        </Badge>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/agents/config/trainer-proposal-card.tsx
git commit -m "feat(web): add TrainerProposalCard"
```

---

### Task 16: `trainer-panel.tsx`

**Files:**
- Create: `apps/web/src/components/agents/config/trainer-panel.tsx`

**Interfaces:**
- Consumes: `useTrainerSession` (Task 14), `TrainerProposalCard` (Task 15).
- Produces: `TrainerPanel` — consumed by `editar/page.tsx` (Task 17).

- [ ] **Step 1: Write the file**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Send } from "lucide-react";
import { TrainerProposalCard } from "./trainer-proposal-card";
import type { useTrainerSession } from "./use-trainer-session";

interface TrainerPanelProps {
  trainer: ReturnType<typeof useTrainerSession>;
}

const QUICK_ACTIONS = [
  { label: "Analisar conversas reais", prompt: "Veja as últimas conversas e sugira melhorias na configuração." },
  { label: "Caçar inconsistências", prompt: "Procure regras conflitantes ou duplicadas na configuração atual." },
  { label: "Ajustar o tom", prompt: "Deixe o tom mais animado." },
  { label: "Regras de negociação", prompt: "Nunca dê desconto sem confirmar antes." },
];

export function TrainerPanel({ trainer }: TrainerPanelProps) {
  const { messages, sendMessage, sending, decideProposal } = trainer;
  const [draft, setDraft] = useState("");
  const messageListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = async (content?: string) => {
    const text = (content ?? draft).trim();
    if (!text || sending) return;
    setDraft("");
    await sendMessage(text);
  };

  return (
    <div className="flex h-full min-h-[400px] flex-col rounded-md border">
      <div className="border-b p-3">
        <p className="mb-2 text-sm font-medium">Treine a Helena conversando</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((action) => (
            <Button key={action.label} type="button" variant="outline" size="sm" onClick={() => handleSend(action.prompt)} disabled={sending}>
              {action.label}
            </Button>
          ))}
        </div>
      </div>
      <div ref={messageListRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Peça uma mudança de comportamento para a Helena, como &quot;deixa o tom mais animado&quot;.
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] space-y-2 rounded-lg px-3 py-2 text-sm",
                message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
              )}
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              {message.proposals.map((proposal) => (
                <TrainerProposalCard key={proposal.id} proposal={proposal} onDecide={decideProposal} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t p-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Digite uma mudança..."
          disabled={sending}
        />
        <Button type="button" size="icon" onClick={() => handleSend()} disabled={sending}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/agents/config/trainer-panel.tsx
git commit -m "feat(web): add TrainerPanel"
```

---

### Task 17: Wire the Trainer tab into the config page

**Files:**
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`

**Interfaces:**
- Consumes: `useTrainerSession` (Task 14), `TrainerPanel` (Task 16), `Badge` (existing `@/components/ui/badge`).
- Produces: 4th tab "Trainer" with a pending-proposals badge, 2-column layout (Trainer chat + docked Playground, reusing the same `playground` session instance already shared by the "Editar" and "Playground" tabs).

- [ ] **Step 1: Add imports**

```ts
import { useTrainerSession } from "@/components/agents/config/use-trainer-session";
import { TrainerPanel } from "@/components/agents/config/trainer-panel";
import { Badge } from "@/components/ui/badge";
```

- [ ] **Step 2: Instantiate the trainer session at page level**

Right after the existing `const playground = usePlaygroundSession(agentId);` line, add:

```ts
const trainer = useTrainerSession(agentId);
```

- [ ] **Step 3: Add the 4th tab trigger, with the pending-proposals badge**

Replace the `TabsList` block:

```tsx
<TabsList variant="line">
  <TabsTrigger value="editar">Editar</TabsTrigger>
  <TabsTrigger value="playground">Playground</TabsTrigger>
  <TabsTrigger value="historico">Histórico</TabsTrigger>
</TabsList>
```

with:

```tsx
<TabsList variant="line">
  <TabsTrigger value="editar">Editar</TabsTrigger>
  <TabsTrigger value="playground">Playground</TabsTrigger>
  <TabsTrigger value="historico">Histórico</TabsTrigger>
  <TabsTrigger value="trainer">
    Trainer
    {trainer.pendingProposalsCount > 0 && (
      <Badge variant="default" className="h-4 min-w-4 px-1 text-[10px]">
        {trainer.pendingProposalsCount}
      </Badge>
    )}
  </TabsTrigger>
</TabsList>
```

- [ ] **Step 4: Add the Trainer tab content**

Right after the existing `<TabsContent value="historico" className="min-h-0">...</TabsContent>` block, before the closing `</Tabs>`, add:

```tsx
<TabsContent value="trainer" className="min-h-0">
  <div className="grid h-full min-h-0 grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
    <div className="min-h-0 lg:h-full">
      <TrainerPanel trainer={trainer} />
    </div>
    <div className="hidden min-h-0 lg:block lg:h-full">
      <PlaygroundPanel playground={playground} />
    </div>
  </div>
</TabsContent>
```

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm --filter @aula-agente/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "feat(web): add the Trainer tab to the config page"
```

---

### Task 18: Manual/E2E acceptance checklist

Not automatable — run these by hand against a local dev environment (`pnpm dev:api` + `pnpm dev:web` + local Supabase) before considering the feature done. Mirrors the checklist in `specs/2026-07-27-helena-trainer-design.md`.

- [ ] Open an agent's Editar page; confirm a 4th "Trainer" tab appears after Histórico, with no badge initially.
- [ ] In Trainer, click the "Ajustar o tom" quick action; confirm the message field is prefilled and sending it produces a proposal card with a diff (e.g. `tom_de_voz: equilibrado → amigavel`), and the Trainer tab badge shows "1".
- [ ] Click "Aplicar" on that proposal; confirm the card switches to a green "Aplicada" badge with no more buttons, the Trainer tab badge drops back to empty, and the "Publicar" badge in `DraftStatusBar` now shows 1 unpublished change.
- [ ] Switch to the Editar tab and confirm Personalidade > Tom de voz reflects the applied change (same draft, same `agent_configs` row).
- [ ] Back in Trainer, type "faz no máximo 3 perguntas de uma vez" (contradicts the existing `perguntas_por_vez.maximo = 1` rule seeded by default); confirm the response explains the conflict with resolution options and shows **no** "Aplicar" button, and the "Publicar" badge does not change.
- [ ] Type "cliente acha caro" after seeding an existing objeção named "Preço alto"; confirm the Trainer points out the duplicate instead of proposing a new objeção.
- [ ] Test the change live in the docked Playground panel on the right of the Trainer tab.
- [ ] Click "Publicar", confirm the dialog lists "Personalidade" with only the item(s) actually changed (e.g. just "Tom de voz"), not the whole section flatly.
- [ ] Confirm `agents.system_prompt`/`agents.model`/etc. only change after that final "Publicar" click — inspect the `agents` row before and after.
- [ ] Run the full test suite once more end-to-end: `cd "/Users/weslleyvalente/Agente IA/superpowers/.claude/worktrees/helena-trainer-plan" && pnpm test`, expect all packages green.

- [ ] **Commit** (only if the checklist above required any fix-up commits; otherwise this task has nothing to commit)
