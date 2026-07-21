# Dashboard Home ("Início") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `/` → `/inbox` redirect with a real overview page (greeting, 4 KPI cards, "Tarefas urgentes" list) so a business owner sees what needs them the moment they open the app.

**Architecture:** A new Fastify route (`GET /organizations/:organizationId/dashboard/summary`) aggregates conversation and message rows into four numbers plus an urgent-conversation list, following the exact fetch-raw-rows-then-aggregate-in-JS pattern already used by `apps/api/src/routes/costs/index.ts`. A new Next.js page at `apps/web/src/app/(dashboard)/page.tsx` renders it, reusing the Card/`label-eyebrow`/`tabular-data`/`StatusLamp` primitives already established on the Costs page. `/` moves into the `(dashboard)` route group (inheriting its auth guard and sidebar for free); the old top-level redirect file is deleted; the sidebar gets an "Início" entry; and post-login now lands on `/` instead of `/inbox` so the new page is actually the landing experience the goal describes, not just a page reachable by clicking the sidebar.

**Tech Stack:** Fastify + Supabase (`@aula-agente/database`), Next.js 16 App Router client components, vitest for the pure-function aggregation test.

## Global Constraints

- Windowed figures (`conversationsLast7d`, `avgResponseSeconds`) use a fixed 7-day window; not configurable in this pass.
- `inProgress` and `needsAttention` are **live snapshots** (not windowed) — copied verbatim from the spec's Data definitions section.
- "Precisam de atenção" = conversations where `is_human_takeover = true` AND the conversation's most recent message has `role = 'contact'`.
- "Tempo de resposta" = average elapsed time between a `role='contact'` message and the next `role='agent'` message that follows it in the same conversation, restricted to contact messages whose `created_at` falls in the 7-day window; contact messages with no following agent reply are excluded from the average.
- `urgentConversations` is capped at 20 rows, sorted oldest-`human_takeover_at`-first.
- No Analytics page, no sidebar section-grouping, no "Nova" tag — out of scope per the spec's Non-goals.

---

### Task 1: Dashboard summary API endpoint

**Files:**
- Modify: `packages/database/src/queries/messages.ts`
- Modify: `packages/database/src/queries/conversations.ts`
- Create: `apps/api/src/routes/dashboard/index.ts`
- Create: `apps/api/src/routes/dashboard/dashboard.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Produces: `buildDashboardSummary(conversations, windowMessages, takeoverConversations, lastMessageByConversationId)` — a pure function, exported from `apps/api/src/routes/dashboard/index.ts`, used directly by the route handler and by the test file. Returns `{ conversationsLast7d: number; inProgress: number; avgResponseSeconds: number | null; needsAttention: number; urgentConversations: Array<{ conversationId: string; contactName: string | null; contactPhone: string; lastMessagePreview: string; lastMessageAt: string }> }`.
- Produces: `getMessagesForDashboard(client, organizationId, sinceISO)` in `packages/database/src/queries/messages.ts`, returning `Array<{ conversation_id: string; role: string; created_at: string }>`.
- Produces: `getHumanTakeoverConversations(client, organizationId)` in `packages/database/src/queries/conversations.ts`, returning `Array<{ id: string; human_takeover_at: string | null; wa_contacts: { name: string | null; phone: string } | null }>`.
- Consumes: `getAdminClient`, `getConversationsByOrganization`, `getRecentMessages` (all already exported from `@aula-agente/database`), `authMiddleware` from `apps/api/src/middleware/auth.js` (same pattern as `apps/api/src/routes/costs/index.ts`).

- [ ] **Step 1: Write the failing test for `buildDashboardSummary`**

Create `apps/api/src/routes/dashboard/dashboard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildDashboardSummary } from "./index.js";

describe("buildDashboardSummary", () => {
  const conversations = [
    { id: "c1", status: "open" },
    { id: "c2", status: "waiting" },
    { id: "c3", status: "resolved" },
    { id: "c4", status: "closed" },
  ];

  const windowMessages = [
    { conversation_id: "c1", role: "contact", created_at: "2026-07-20T10:00:00.000Z" },
    { conversation_id: "c1", role: "agent", created_at: "2026-07-20T10:00:30.000Z" },
    { conversation_id: "c2", role: "contact", created_at: "2026-07-20T11:00:00.000Z" },
    { conversation_id: "c2", role: "contact", created_at: "2026-07-20T11:00:10.000Z" },
    { conversation_id: "c2", role: "agent", created_at: "2026-07-20T11:01:30.000Z" },
    { conversation_id: "c2", role: "contact", created_at: "2026-07-20T11:05:00.000Z" },
    { conversation_id: "c3", role: "contact", created_at: "2026-07-20T09:00:00.000Z" },
  ];

  const takeoverConversations = [
    {
      id: "t1",
      human_takeover_at: "2026-07-19T08:00:00.000Z",
      wa_contacts: { name: null, phone: "5511999990000" },
    },
    {
      id: "t2",
      human_takeover_at: "2026-07-19T09:00:00.000Z",
      wa_contacts: { name: "Bruno", phone: "5511999991111" },
    },
  ];

  const lastMessageByConversationId = {
    t1: { role: "contact", content: "Ainda estou esperando", created_at: "2026-07-20T12:00:00.000Z" },
    t2: { role: "human_agent", content: "Já te respondi, tudo certo!", created_at: "2026-07-20T12:30:00.000Z" },
  };

  it("counts distinct conversations with activity in the window, regardless of status", () => {
    const result = buildDashboardSummary(conversations, windowMessages, [], {});
    expect(result.conversationsLast7d).toBe(3); // c1, c2, c3 — c4 has no messages in the window
  });

  it("counts only open/waiting conversations as in progress", () => {
    const result = buildDashboardSummary(conversations, windowMessages, [], {});
    expect(result.inProgress).toBe(2); // c1 (open), c2 (waiting) — not c3 (resolved) or c4 (closed)
  });

  it("averages response time between a contact message and the next agent reply, ignoring unanswered contact messages", () => {
    const result = buildDashboardSummary(conversations, windowMessages, [], {});
    // c1: 30s. c2: the contact message at 11:00:00 pairs with the agent
    // reply at 11:01:30 (90s) — the contact message at 11:00:10 is ignored
    // because a reply was already pending, and the contact message at
    // 11:05:00 has no following agent reply so it's excluded entirely.
    expect(result.avgResponseSeconds).toBe(60); // (30 + 90) / 2
  });

  it("returns null response time when there are no answered pairs in the window", () => {
    const result = buildDashboardSummary(conversations, [], [], {});
    expect(result.avgResponseSeconds).toBeNull();
  });

  it("only surfaces takeover conversations whose last message is still from the contact", () => {
    const result = buildDashboardSummary(conversations, [], takeoverConversations, lastMessageByConversationId);

    expect(result.needsAttention).toBe(1);
    expect(result.urgentConversations).toEqual([
      {
        conversationId: "t1",
        contactName: null,
        contactPhone: "5511999990000",
        lastMessagePreview: "Ainda estou esperando",
        lastMessageAt: "2026-07-20T12:00:00.000Z",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @aula-agente/api exec vitest run src/routes/dashboard/dashboard.test.ts`
Expected: FAIL — `Cannot find module './index.js'` (the route file doesn't exist yet).

- [ ] **Step 3: Add the database query functions**

In `packages/database/src/queries/messages.ts`, add this function after `getAgentMessagesForCost`:

```ts
export async function getMessagesForDashboard(
  client: SupabaseClient,
  organizationId: string,
  sinceISO: string
) {
  const { data, error } = await client
    .from("messages")
    .select("conversation_id, role, created_at")
    .eq("organization_id", organizationId)
    .gte("created_at", sinceISO)
    .order("conversation_id", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Array<{ conversation_id: string; role: string; created_at: string }>;
}
```

In `packages/database/src/queries/conversations.ts`, add this function after `getExpiredTakeovers`:

```ts
export async function getHumanTakeoverConversations(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("conversations")
    .select("id, human_takeover_at, wa_contacts(name, phone)")
    .eq("organization_id", organizationId)
    .eq("is_human_takeover", true)
    .order("human_takeover_at", { ascending: true });
  if (error) throw error;
  return data as Array<{
    id: string;
    human_takeover_at: string | null;
    wa_contacts: { name: string | null; phone: string } | null;
  }>;
}
```

- [ ] **Step 4: Build the database package so the API can import the new functions**

Run: `pnpm --filter @aula-agente/database build`
Expected: exits 0, no output.

- [ ] **Step 5: Write the route file with `buildDashboardSummary`**

Create `apps/api/src/routes/dashboard/index.ts`:

```ts
import type { FastifyInstance } from "fastify";
import {
  getAdminClient,
  getConversationsByOrganization,
  getMessagesForDashboard,
  getHumanTakeoverConversations,
  getRecentMessages,
} from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";

const WINDOW_DAYS = 7;
const MAX_URGENT = 20;

interface DashboardConversationRow {
  id: string;
  status: string;
}

interface DashboardMessageRow {
  conversation_id: string;
  role: string;
  created_at: string;
}

interface TakeoverConversationRow {
  id: string;
  human_takeover_at: string | null;
  wa_contacts: { name: string | null; phone: string } | null;
}

interface LastMessageRow {
  role: string;
  content: string;
  created_at: string;
}

export function buildDashboardSummary(
  conversations: DashboardConversationRow[],
  windowMessages: DashboardMessageRow[],
  takeoverConversations: TakeoverConversationRow[],
  lastMessageByConversationId: Record<string, LastMessageRow | undefined>
) {
  const inProgress = conversations.filter((c) => c.status === "open" || c.status === "waiting").length;

  const conversationsLast7d = new Set(windowMessages.map((m) => m.conversation_id)).size;

  const messagesByConversation = new Map<string, DashboardMessageRow[]>();
  for (const msg of windowMessages) {
    const list = messagesByConversation.get(msg.conversation_id) || [];
    list.push(msg);
    messagesByConversation.set(msg.conversation_id, list);
  }

  const responseDeltasMs: number[] = [];
  for (const msgs of messagesByConversation.values()) {
    let pendingContactAt: number | null = null;
    for (const msg of msgs) {
      if (msg.role === "contact") {
        if (pendingContactAt === null) {
          pendingContactAt = new Date(msg.created_at).getTime();
        }
      } else if (msg.role === "agent" && pendingContactAt !== null) {
        responseDeltasMs.push(new Date(msg.created_at).getTime() - pendingContactAt);
        pendingContactAt = null;
      }
    }
  }
  const avgResponseSeconds =
    responseDeltasMs.length > 0
      ? responseDeltasMs.reduce((sum, ms) => sum + ms, 0) / responseDeltasMs.length / 1000
      : null;

  const needsAttentionConversations = takeoverConversations.filter(
    (c) => lastMessageByConversationId[c.id]?.role === "contact"
  );

  const urgentConversations = needsAttentionConversations.slice(0, MAX_URGENT).map((c) => {
    const lastMessage = lastMessageByConversationId[c.id]!;
    return {
      conversationId: c.id,
      contactName: c.wa_contacts?.name ?? null,
      contactPhone: c.wa_contacts?.phone ?? "",
      lastMessagePreview: lastMessage.content,
      lastMessageAt: lastMessage.created_at,
    };
  });

  return {
    conversationsLast7d,
    inProgress,
    avgResponseSeconds,
    needsAttention: needsAttentionConversations.length,
    urgentConversations,
  };
}

export default async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/dashboard/summary",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const sinceISO = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

      const [conversations, windowMessages, takeoverConversations] = await Promise.all([
        getConversationsByOrganization(db, organizationId),
        getMessagesForDashboard(db, organizationId, sinceISO),
        getHumanTakeoverConversations(db, organizationId),
      ]);

      const lastMessages = await Promise.all(
        takeoverConversations.map((c) => getRecentMessages(db, c.id, 1))
      );
      const lastMessageByConversationId: Record<string, LastMessageRow | undefined> = {};
      takeoverConversations.forEach((c, i) => {
        lastMessageByConversationId[c.id] = lastMessages[i][0];
      });

      return buildDashboardSummary(
        conversations,
        windowMessages,
        takeoverConversations,
        lastMessageByConversationId
      );
    }
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @aula-agente/api exec vitest run src/routes/dashboard/dashboard.test.ts`
Expected: PASS — 5 tests passing.

- [ ] **Step 7: Register the route**

In `apps/api/src/server.ts`, add the import next to the other route imports:

```ts
import costRoutes from "./routes/costs/index.js";
import dashboardRoutes from "./routes/dashboard/index.js";
```

And register it next to `server.register(costRoutes);`:

```ts
server.register(costRoutes);
server.register(dashboardRoutes);
```

- [ ] **Step 8: Typecheck the API package**

Run: `pnpm --filter @aula-agente/api exec tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 9: Commit**

```bash
git add packages/database/src/queries/messages.ts packages/database/src/queries/conversations.ts apps/api/src/routes/dashboard apps/api/src/server.ts
git commit -m "feat: add dashboard summary endpoint (conversations, response time, urgent list)"
```

---

### Task 2: Início page, sidebar entry, and landing route move

**Files:**
- Create: `apps/web/src/app/(dashboard)/page.tsx`
- Delete: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/components/layout/app-sidebar.tsx`
- Modify: `apps/web/src/app/(auth)/auth-form.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `@/lib/api` (existing helper, used exactly like `apps/web/src/app/(dashboard)/costs/page.tsx` does), `useOrganization` from `@/providers/organization-provider`, `StatusLamp` from `@/components/ui/status-lamp` (tones: `"green" | "amber" | "rust" | "off"`), `Card`/`CardHeader`/`CardTitle`/`CardContent` from `@/components/ui/card`, `Badge` from `@/components/ui/badge` (variant `"destructive"`), `Avatar`/`AvatarFallback` from `@/components/ui/avatar`.
- Consumes: the `GET /organizations/:organizationId/dashboard/summary` response shape produced by Task 1: `{ conversationsLast7d: number; inProgress: number; avgResponseSeconds: number | null; needsAttention: number; urgentConversations: Array<{ conversationId: string; contactName: string | null; contactPhone: string; lastMessagePreview: string; lastMessageAt: string }> }`.

- [ ] **Step 1: Delete the old root redirect page**

```bash
rm apps/web/src/app/page.tsx
```

- [ ] **Step 2: Create the Início page**

Create `apps/web/src/app/(dashboard)/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusLamp } from "@/components/ui/status-lamp";

interface UrgentConversation {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  lastMessagePreview: string;
  lastMessageAt: string;
}

interface DashboardSummary {
  conversationsLast7d: number;
  inProgress: number;
  avgResponseSeconds: number | null;
  needsAttention: number;
  urgentConversations: UrgentConversation[];
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return { text: "Bom dia", icon: "☀️" };
  if (hour < 18) return { text: "Boa tarde", icon: "☀️" };
  return { text: "Boa noite", icon: "🌙" };
}

function formatFullDate() {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
}

function formatResponseTime(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)}m`;
}

function formatRelativeTime(iso: string) {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `há ${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  return `há ${diffD} dia${diffD > 1 ? "s" : ""}`;
}

export default function HomePage() {
  const { currentOrg } = useOrganization();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) return;
    apiFetch(`/organizations/${currentOrg.id}/dashboard/summary`)
      .then(setSummary)
      .finally(() => setLoading(false));
  }, [currentOrg]);

  if (loading) return <div>Carregando...</div>;
  if (!summary) return <div>Nao foi possivel carregar o resumo.</div>;

  const { text, icon } = greeting();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{text}, {icon}</h1>
        <p className="text-sm text-muted-foreground">
          Aqui está o que precisa da sua atenção hoje, {formatFullDate()}.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Conversas (7 dias)</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">
            {summary.conversationsLast7d}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Em andamento</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">
            {summary.inProgress}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Tempo de resposta</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">
            {formatResponseTime(summary.avgResponseSeconds)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Precisam de atenção</p>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-2xl font-medium">
            <span className="tabular-data">{summary.needsAttention}</span>
            {summary.needsAttention > 0 && <StatusLamp tone="rust" pulse />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tarefas urgentes</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.urgentConversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma conversa esperando atenção.</p>
          ) : (
            <div className="divide-y divide-border">
              {summary.urgentConversations.map((c) => (
                <Link
                  key={c.conversationId}
                  href={`/inbox?id=${c.conversationId}`}
                  className="flex items-center gap-3 py-3 transition-colors hover:bg-accent/50"
                >
                  <Avatar>
                    <AvatarFallback>
                      {(c.contactName || c.contactPhone)[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.contactName || c.contactPhone}</p>
                    <p className="truncate text-sm text-muted-foreground">{c.lastMessagePreview}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="tabular-data text-xs text-muted-foreground">
                      {formatRelativeTime(c.lastMessageAt)}
                    </span>
                    <Badge variant="destructive">Urgente</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Add "Início" to the sidebar and fix the active-route check for `/`**

In `apps/web/src/components/layout/app-sidebar.tsx`, update the icon import and `navigation` array:

```tsx
import { Home, Inbox, Bot, Radio, Users, Settings, DollarSign } from "lucide-react";
```

```tsx
const navigation = [
  { name: "Início", href: "/", icon: Home },
  { name: "Inbox", href: "/inbox", icon: Inbox },
  { name: "Agentes", href: "/agents", icon: Bot },
  { name: "Instancias", href: "/instances", icon: Radio },
  { name: "Custos", href: "/costs", icon: DollarSign },
  { name: "Equipe", href: "/team", icon: Users },
  { name: "Configuracoes", href: "/settings", icon: Settings },
];
```

Then update the active check inside the `navigation.map` (currently `const isActive = pathname.startsWith(item.href);`) so `/` doesn't match every route:

```tsx
const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
```

- [ ] **Step 4: Land on `/` after login instead of `/inbox`**

In `apps/web/src/app/(auth)/auth-form.tsx`, change:

```ts
router.push("/inbox");
```

to:

```ts
router.push("/");
```

- [ ] **Step 5: Typecheck the web package**

Run: `pnpm --filter @aula-agente/web exec tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 6: Manually verify in the browser**

With the web dev server running (`pnpm --filter @aula-agente/web dev`, or reuse an already-running instance), navigate to `http://localhost:3000/`. Confirm:
- The page shows the greeting, today's date, and 4 KPI cards with real numbers (not stuck on "Carregando...").
- "Início" appears first in the sidebar and is the only highlighted item on `/` — navigate to `/inbox`, `/costs`, etc. and confirm each highlights only its own item (this specifically checks the Step 3 active-route fix didn't regress).
- If any conversation in the organization has `is_human_takeover = true` with an unanswered contact message, it appears under "Tarefas urgentes" and clicking it opens `/inbox?id=<that conversation>`. If none exist, confirm the empty-state message renders instead.
- Log out and log back in; confirm you land on `/` rather than `/inbox`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/\(dashboard\)/page.tsx apps/web/src/components/layout/app-sidebar.tsx apps/web/src/app/\(auth\)/auth-form.tsx
git commit -m "feat: add Início overview page as the new dashboard landing route"
```

---

## Self-Review Notes

- **Spec coverage:** all four KPI definitions, the urgent list, empty state, click-through to `/inbox?id=`, and the sidebar entry from the spec are each covered by a task step. The spec's Goal ("business owner opens the app and immediately sees...") is only fully met if the post-login destination changes too, so Task 2 Step 4 (not explicitly named in the spec's Architecture section, but required by its Goal) is included.
- **Type consistency:** `DashboardSummary` in the frontend (Task 2 Step 2) matches `buildDashboardSummary`'s return shape (Task 1 Step 5) field-for-field, including `contactName: string | null` and `avgResponseSeconds: number | null`.
- **No placeholders:** every step has complete, runnable code.
