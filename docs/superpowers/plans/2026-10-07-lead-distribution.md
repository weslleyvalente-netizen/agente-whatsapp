# Distribuição de leads (rodízio) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distribuir cada novo handoff qualificado da Mariana entre Marina e Márcio em rodízio 50/50, com dono persistido, SLA de 15 minutos úteis, redistribuição automática, fila de exceções e histórico imutável.

**Architecture:** Funções atômicas no Postgres (`distribute_lead`, `redistribute_assignment`, `record_human_message`, `accept_assignment`, `manual_assign`) guardam o estado do rodízio em `lead_distribution_state` e todo o histórico em `lead_assignments`. A aplicação calcula o prazo (`sla_due_at`) com um calendário comercial puro e testável em `packages/shared`. Um job do BullMQ roda a cada 60 s e redistribui atribuições vencidas. API e telas filtram por vendedor; a flag `lead_distribution_enabled` fica desligada até tudo estar pronto.

**Tech Stack:** TypeScript (pnpm/turbo monorepo), Vitest, Fastify (`apps/api`), BullMQ (`apps/worker`, `packages/queue`), Supabase/Postgres (`supabase/migrations`), Next.js (`apps/web`), `@electric-sql/pglite` para testes de SQL.

**Spec:** `docs/superpowers/specs/2026-10-07-lead-distribution-design.md` (aprovada em 07/10/2026). Leia a spec antes de começar.

## Global Constraints

- Flag `lead_distribution_enabled` **desligada por padrão**; com ela desligada nada muda no comportamento atual. Só handoffs com `handed_at >= lead_distribution_activated_at` entram.
- **Sem RLS novo** nesta fase (isolamento por vendedor só na API e na tela). Registrado como fase 2 na spec.
- **Nenhuma redistribuição em massa.** Marcar um vendedor `out` não move lead algum. Não existe função de reatribuição em lote neste plano (ação administrativa separada, fora de escopo). O valor `bulk_reassignment` do campo `reason` fica reservado.
- Rodízio 50/50: `lead_distribution_state.last_rotation_order` é a **única** fonte de "quem é o próximo". `sales_reps.last_assigned_at` é só auditoria.
- SLA padrão **15 minutos úteis** (`lead_sla_minutes`); varredura a cada **60 segundos** (fila `lead-sla`).
- Fuso `America/Sao_Paulo`. Calendário padrão: segunda a sexta 08:00–18:00; sábado e domingo fechados; tudo configurável em `business_calendar`. Nunca fixar sábado na lógica.
- `lead_assignments` é **imutável**: nunca `DELETE`; campos protegidos nunca mudam.
- Cada vendedor recebe o mesmo handoff **no máximo uma vez** por cadeia automática (índice único no banco).
- Papéis: `owner` e `admin` são gestores; `agent` é vendedor.
- Motivos de exceção (valores exatos): `no_available_rep`, `all_reps_sla_breached`, `invalid_existing_owner`, `distribution_error`, `manual_review`.
- Estados de atribuição (valores exatos): `pending`, `accepted`, `expired`, `redistributed`, `exception`.
- Nenhuma migration é aplicada em produção por este plano; aplicar só com autorização do usuário (`supabase db push`).
- Commits ao final de cada task, em branch dedicada `feat/lead-distribution`, **sem push** até a task 12.

## Decisões tomadas ao planejar (leia antes de implementar)

1. **Visibilidade do vendedor no legado.** A spec diz "vendedor vê só os próprios leads". Como a base antiga não é redistribuída e hoje o dono costuma ser a conta compartilhada, aplicar isso à risca faria a Marina perder de vista a carteira atual na ativação. Por isso, na fase 1, o filtro **esconde apenas leads cujo dono é outro vendedor** (`sales_reps`); leads sem dono, com dono legado (que não é vendedor) ou dela continuam visíveis. Isso é uma interpretação mais branda da spec e está sinalizada ao usuário na entrega.
2. **Tarefas e inbox** são lidos direto do Supabase pelo web; nesta fase eles só ganham filtro "Minhas" na **tela** (sem garantia de banco). As rotas da API que filtram de verdade são: lista de negócios, tarefas sem negócio, "Hoje", detalhes de negócio e detalhes de tarefa.
3. **SLA vale para toda atribuição**, inclusive `existing_owner`.
4. **Mensagem de saudação curta pelo celular** ("Bom dia", já filtrada como `fromMe_greeting_filtered`) **não assume** o lead.
5. **Concorrência:** PGlite é conexão única, então não dá para provar a corrida real em teste. A segurança vem de `SELECT ... FOR UPDATE` em `lead_distribution_state` e dos índices únicos, que **são** testados.

## Review Focus

Entradas e falhas que a spec implica mas nenhuma task testaria sozinha. Cada uma tem teste na task indicada:

1. **Calendário mal configurado** (sem nenhuma janela) não pode derrubar a distribuição: usa o padrão. Teste na Task 1 e Task 6.
2. **Vendedor removido da organização** que ainda é dono de um negócio aberto vira exceção `invalid_existing_owner`, sem crash. Teste na Task 4.
3. **Zero vendedores cadastrados** com a flag ligada: exceção `no_available_rep`; o `requestHuman` nunca falha por causa da distribuição. Testes nas Tasks 4 e 7.
4. **Mensagem humana de quem não é o vendedor atribuído** (admin) registra `first_human_message_by` mas não assume o lead. Teste na Task 5.
5. **Dois handoffs do mesmo evento** (reprocessamento) não criam duas atribuições. Teste na Task 4.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `packages/shared/src/business-calendar.ts` (novo) | Calendário comercial puro: `isBusinessOpen`, `addBusinessMinutes`, `resolveBusinessCalendar` |
| `packages/shared/src/lead-distribution.ts` (novo) | Tipos, constantes, `pickRep`, `isHumanOriginMessage` |
| `packages/shared/src/types/organization.ts` (mod.) | Chaves novas em `OrganizationSettings` |
| `supabase/migrations/20261007120000_lead_distribution_schema.sql` (novo) | Tabelas, colunas, índices, gatilho de imutabilidade, view, RLS de leitura |
| `supabase/migrations/20261007120100_lead_distribution_assign.sql` (novo) | `resolve_current_owner`, `distribute_lead` |
| `supabase/migrations/20261007120200_lead_distribution_lifecycle.sql` (novo) | `redistribute_assignment`, `accept_assignment`, `record_human_message`, `manual_assign` |
| `packages/database/src/sql/*.test.ts` + `fixture.ts` (novos) | Testes de SQL em PGlite |
| `packages/database/src/queries/lead-distribution.ts` (novo) | Funções TypeScript sobre as RPCs e leituras |
| `packages/agent-runtime/src/handoff-distribution.ts` (novo) | `safeDistribute`: chama a distribuição sem nunca quebrar o handoff |
| `packages/agent-runtime/src/tools/request-human.ts` (mod.) | Chama a distribuição depois do handoff |
| `apps/worker/src/workers/lead-sla.ts` (novo) | Varredura de SLA a cada 60 s |
| `packages/queue/src/queues.ts`, `packages/shared/src/constants.ts` (mod.) | Fila `lead-sla` |
| `apps/api/src/services/message-send.service.ts`, `apps/api/src/routes/webhooks/evolution.ts` (mod.) | Primeira mensagem humana assume o lead |
| `apps/api/src/lib/lead-visibility.ts` (novo) | Regra de visibilidade por vendedor |
| `apps/api/src/routes/lead-distribution/index.ts` (novo) | Rotas de vendedores, aceite, exceções, histórico, reatribuição manual |
| `apps/api/src/services/sales-workspace.service.ts`, `apps/api/src/routes/opportunities/index.ts`, `apps/api/src/routes/dashboard/index.ts`, `apps/api/src/routes/tasks/index.ts` (mod.) | Aplicam visibilidade e anexam a atribuição ao card |
| `apps/web/src/components/lead-distribution/*.tsx` (novos) + pontos de montagem | Telas |
| `docs/runbook-distribuicao-leads.md` (novo) | Ativação e reversão |

---

### Task 1: Calendário comercial (puro)

**Files:**
- Create: `packages/shared/src/business-calendar.ts`
- Create: `packages/shared/src/business-calendar.test.ts`
- Modify: `packages/shared/src/index.ts` (adicionar `export * from "./business-calendar.js";`)

**Interfaces:**
- Produces:
  - `type BusinessCalendar = { timeZone: string; weekly: Partial<Record<Weekday, BusinessWindow[]>>; closedDates?: string[]; closedPeriods?: Array<{from: string; to: string; reason?: string}> }`
  - `DEFAULT_BUSINESS_CALENDAR: BusinessCalendar`
  - `resolveBusinessCalendar(raw: unknown): BusinessCalendar` (devolve o padrão se `raw` for inválido ou sem janelas)
  - `isBusinessOpen(date: Date, calendar?: BusinessCalendar): boolean`
  - `addBusinessMinutes(start: Date, minutes: number, calendar?: BusinessCalendar): Date` (lança `Error` se o calendário não tiver nenhuma janela aberta nos próximos 370 dias)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/business-calendar.test.ts
import { describe, expect, it } from "vitest";
import {
  addBusinessMinutes, DEFAULT_BUSINESS_CALENDAR, isBusinessOpen, resolveBusinessCalendar,
  type BusinessCalendar,
} from "./business-calendar.js";

// 2026-10-09 é sexta, 10 sábado, 11 domingo, 12 segunda. America/Sao_Paulo = UTC-3 (sem horário de verão).
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("isBusinessOpen", () => {
  it("abre em dia útil dentro da janela e fecha fora dela", () => {
    expect(isBusinessOpen(at("2026-10-09T11:00:00Z"))).toBe(true);   // sex 08:00
    expect(isBusinessOpen(at("2026-10-09T20:59:00Z"))).toBe(true);   // sex 17:59
    expect(isBusinessOpen(at("2026-10-09T21:00:00Z"))).toBe(false);  // sex 18:00
    expect(isBusinessOpen(at("2026-10-09T09:00:00Z"))).toBe(false);  // sex 06:00
  });
  it("fica fechado de madrugada, sábado e domingo", () => {
    expect(isBusinessOpen(at("2026-10-09T05:00:00Z"))).toBe(false);  // sex 02:00
    expect(isBusinessOpen(at("2026-10-10T15:00:00Z"))).toBe(false);  // sáb 12:00
    expect(isBusinessOpen(at("2026-10-11T15:00:00Z"))).toBe(false);  // dom 12:00
  });
  it("respeita data fechada e período fechado", () => {
    const cal: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedDates: ["2026-10-12"] };
    expect(isBusinessOpen(at("2026-10-12T15:00:00Z"), cal)).toBe(false);
    const period: BusinessCalendar = {
      ...DEFAULT_BUSINESS_CALENDAR,
      closedPeriods: [{ from: "2026-10-13T00:00:00-03:00", to: "2026-10-14T00:00:00-03:00", reason: "recesso" }],
    };
    expect(isBusinessOpen(at("2026-10-13T15:00:00Z"), period)).toBe(false);
    expect(isBusinessOpen(at("2026-10-14T15:00:00Z"), period)).toBe(true);
  });
  it("aceita janela de sábado configurada, sem fixar sábado na lógica", () => {
    const cal: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, weekly: { ...DEFAULT_BUSINESS_CALENDAR.weekly, sat: [{ start: "08:00", end: "12:00" }] } };
    expect(isBusinessOpen(at("2026-10-10T14:00:00Z"), cal)).toBe(true);   // sáb 11:00
    expect(isBusinessOpen(at("2026-10-10T15:00:00Z"), cal)).toBe(false);  // sáb 12:00
  });
});

describe("addBusinessMinutes", () => {
  it("soma dentro do expediente", () => {
    expect(iso(addBusinessMinutes(at("2026-10-05T12:00:00Z"), 15))).toBe("2026-10-05T12:15:00.000Z"); // seg 09:00
  });
  it("antes de abrir, o relógio começa na abertura", () => {
    expect(iso(addBusinessMinutes(at("2026-10-05T10:00:00Z"), 15))).toBe("2026-10-05T11:15:00.000Z"); // seg 07:00 → 08:15
  });
  it("atravessa o fim do expediente e o fim de semana", () => {
    expect(iso(addBusinessMinutes(at("2026-10-09T20:50:00Z"), 15))).toBe("2026-10-12T11:05:00.000Z"); // sex 17:50 → seg 08:05
  });
  it("sábado e domingo só começam a contar na segunda", () => {
    expect(iso(addBusinessMinutes(at("2026-10-10T15:00:00Z"), 15))).toBe("2026-10-12T11:15:00.000Z");
    expect(iso(addBusinessMinutes(at("2026-10-11T15:00:00Z"), 15))).toBe("2026-10-12T11:15:00.000Z");
  });
  it("de madrugada só conta a partir da abertura", () => {
    expect(iso(addBusinessMinutes(at("2026-10-06T05:00:00Z"), 15))).toBe("2026-10-06T11:15:00.000Z"); // ter 02:00 → 08:15
  });
  it("pula feriado e período fechado", () => {
    const holiday: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedDates: ["2026-10-12"] };
    expect(iso(addBusinessMinutes(at("2026-10-09T20:50:00Z"), 15, holiday))).toBe("2026-10-13T11:05:00.000Z");
    const period: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedPeriods: [{ from: "2026-10-12T00:00:00-03:00", to: "2026-10-13T00:00:00-03:00" }] };
    expect(iso(addBusinessMinutes(at("2026-10-09T20:50:00Z"), 15, period))).toBe("2026-10-13T11:05:00.000Z");
  });
  it("usa a janela de sábado quando configurada", () => {
    const cal: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, weekly: { ...DEFAULT_BUSINESS_CALENDAR.weekly, sat: [{ start: "08:00", end: "12:00" }] } };
    expect(iso(addBusinessMinutes(at("2026-10-10T14:50:00Z"), 15, cal))).toBe("2026-10-12T11:05:00.000Z"); // sáb 11:50 → seg 08:05
  });
  it("zero minutos devolve o próprio instante", () => {
    expect(iso(addBusinessMinutes(at("2026-10-05T12:00:00Z"), 0))).toBe("2026-10-05T12:00:00.000Z");
  });
  it("lança quando o calendário não tem nenhuma janela aberta", () => {
    expect(() => addBusinessMinutes(at("2026-10-05T12:00:00Z"), 15, { timeZone: "America/Sao_Paulo", weekly: {} })).toThrow();
  });
});

describe("resolveBusinessCalendar", () => {
  it("usa o padrão para valores ausentes, inválidos ou sem janelas", () => {
    expect(resolveBusinessCalendar(undefined)).toEqual(DEFAULT_BUSINESS_CALENDAR);
    expect(resolveBusinessCalendar("lixo")).toEqual(DEFAULT_BUSINESS_CALENDAR);
    expect(resolveBusinessCalendar({ timeZone: "America/Sao_Paulo", weekly: {} })).toEqual(DEFAULT_BUSINESS_CALENDAR);
    expect(resolveBusinessCalendar({ timeZone: "Nao/Existe", weekly: { mon: [{ start: "08:00", end: "18:00" }] } })).toEqual(DEFAULT_BUSINESS_CALENDAR);
    expect(resolveBusinessCalendar({ weekly: { mon: [{ start: "25:00", end: "18:00" }] } })).toEqual(DEFAULT_BUSINESS_CALENDAR);
  });
  it("aceita um calendário válido e completa o fuso", () => {
    const cal = resolveBusinessCalendar({ weekly: { sat: [{ start: "08:00", end: "12:00" }] } });
    expect(cal.timeZone).toBe("America/Sao_Paulo");
    expect(cal.weekly.sat).toEqual([{ start: "08:00", end: "12:00" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/shared exec vitest run src/business-calendar.test.ts`
Expected: FAIL (módulo `./business-calendar.js` inexistente).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/business-calendar.ts
// Calendário comercial para prazos em "minutos úteis". Funções puras: nada de relógio global.
export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export interface BusinessWindow { start: string; end: string } // "HH:MM", fim exclusivo
export interface BusinessCalendar {
  timeZone: string;
  weekly: Partial<Record<Weekday, BusinessWindow[]>>;
  closedDates?: string[]; // "YYYY-MM-DD" no fuso do calendário
  closedPeriods?: Array<{ from: string; to: string; reason?: string }>; // instantes ISO, [from, to)
}

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MS = 86_400_000;
const MAX_DAYS = 370;
const WORKDAY: BusinessWindow[] = [{ start: "08:00", end: "18:00" }];

export const DEFAULT_BUSINESS_CALENDAR: BusinessCalendar = {
  timeZone: "America/Sao_Paulo",
  weekly: { mon: WORKDAY, tue: WORKDAY, wed: WORKDAY, thu: WORKDAY, fri: WORKDAY },
  closedDates: [],
  closedPeriods: [],
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(t: number, timeZone: string) {
  const p: Record<string, string> = {};
  for (const x of formatter(timeZone).formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: WEEKDAYS[["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(p.weekday.toLowerCase().slice(0, 3))] };
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (y: number, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// Instante em que o relógio local do fuso marca y-mo-d h:mi.
function zonedToInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, timeZone);
    guess += wanted - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return guess;
}

function closedPeriodAt(t: number, cal: BusinessCalendar) {
  return (cal.closedPeriods ?? []).map(p => ({ from: Date.parse(p.from), to: Date.parse(p.to) }))
    .find(p => Number.isFinite(p.from) && Number.isFinite(p.to) && p.from <= t && t < p.to) ?? null;
}

function nextClosedPeriodStart(t: number, cal: BusinessCalendar): number {
  return (cal.closedPeriods ?? []).map(p => Date.parse(p.from)).filter(f => Number.isFinite(f) && f > t).sort((a, b) => a - b)[0] ?? Infinity;
}

// Fim da janela aberta que contém t, ou null se t está fora do expediente.
function openUntil(t: number, cal: BusinessCalendar): number | null {
  const p = parts(t, cal.timeZone);
  if ((cal.closedDates ?? []).includes(isoDay(p.y, p.mo, p.d))) return null;
  const now = p.h * 60 + p.mi;
  for (const w of cal.weekly[p.wd] ?? []) {
    if (minutesOf(w.start) <= now && now < minutesOf(w.end)) {
      const end = minutesOf(w.end);
      return zonedToInstant(p.y, p.mo, p.d, Math.floor(end / 60), end % 60, cal.timeZone);
    }
  }
  return null;
}

// Próxima abertura estritamente depois de t (ignora períodos fechados; o laço principal os trata).
function nextOpening(t: number, cal: BusinessCalendar): number | null {
  const p = parts(t, cal.timeZone);
  const base = Date.UTC(p.y, p.mo - 1, p.d);
  for (let offset = 0; offset <= MAX_DAYS; offset++) {
    const day = new Date(base + offset * DAY_MS);
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    if ((cal.closedDates ?? []).includes(isoDay(y, mo, d))) continue;
    const windows = [...(cal.weekly[WEEKDAYS[day.getUTCDay()]] ?? [])].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    for (const w of windows) {
      const s = minutesOf(w.start);
      const instant = zonedToInstant(y, mo, d, Math.floor(s / 60), s % 60, cal.timeZone);
      if (instant > t) return instant;
    }
  }
  return null;
}

export function isBusinessOpen(date: Date, calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR): boolean {
  const t = date.getTime();
  return closedPeriodAt(t, calendar) === null && openUntil(t, calendar) !== null;
}

export function addBusinessMinutes(start: Date, minutes: number, calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR): Date {
  let remaining = Math.max(0, minutes);
  let t = start.getTime();
  if (remaining === 0) return new Date(t);
  for (let guard = 0; guard < 20_000; guard++) {
    const period = closedPeriodAt(t, calendar);
    if (period) { t = period.to; continue; }
    const end = openUntil(t, calendar);
    if (end === null) {
      const next = nextOpening(t, calendar);
      if (next === null) throw new Error("Calendário comercial sem janelas abertas.");
      t = next;
      continue;
    }
    const segmentEnd = Math.min(end, nextClosedPeriodStart(t, calendar));
    const available = (segmentEnd - t) / 60_000;
    if (remaining <= available) return new Date(t + remaining * 60_000);
    remaining -= available;
    t = segmentEnd;
  }
  throw new Error("Calendário comercial sem janelas abertas.");
}

function validWindow(w: unknown): w is BusinessWindow {
  if (!w || typeof w !== "object") return false;
  const { start, end } = w as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  return ok(start) && ok(end) && minutesOf(start as string) < minutesOf(end as string);
}

/** Aceita a configuração crua da organização; qualquer problema devolve o calendário padrão (nunca derruba a distribuição). */
export function resolveBusinessCalendar(raw: unknown): BusinessCalendar {
  if (!raw || typeof raw !== "object") return DEFAULT_BUSINESS_CALENDAR;
  const r = raw as Record<string, any>;
  const timeZone = typeof r.timeZone === "string" ? r.timeZone : DEFAULT_BUSINESS_CALENDAR.timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { return DEFAULT_BUSINESS_CALENDAR; }
  const weekly: BusinessCalendar["weekly"] = {};
  for (const day of WEEKDAYS) {
    const list = r.weekly?.[day];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every(validWindow)) return DEFAULT_BUSINESS_CALENDAR;
    if (list.length) weekly[day] = list;
  }
  if (!Object.keys(weekly).length) return DEFAULT_BUSINESS_CALENDAR;
  const closedDates = Array.isArray(r.closedDates) ? r.closedDates.filter((d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const closedPeriods = Array.isArray(r.closedPeriods)
    ? r.closedPeriods.filter((p: any) => p && Number.isFinite(Date.parse(p.from)) && Number.isFinite(Date.parse(p.to)) && Date.parse(p.from) < Date.parse(p.to))
    : [];
  return { timeZone, weekly, closedDates, closedPeriods };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/shared exec vitest run src/business-calendar.test.ts`
Expected: PASS (todos os testes).

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/lead-distribution
echo 'export * from "./business-calendar.js";' >> packages/shared/src/index.ts
pnpm --filter @aula-agente/shared exec vitest run src/business-calendar.test.ts
git add packages/shared/src/business-calendar.ts packages/shared/src/business-calendar.test.ts packages/shared/src/index.ts
git commit -m "feat(distribution): business calendar with minutes-based SLA arithmetic"
```

---

### Task 2: Domínio da distribuição (puro): tipos, `pickRep`, origem humana

**Files:**
- Create: `packages/shared/src/lead-distribution.ts`
- Create: `packages/shared/src/lead-distribution.test.ts`
- Modify: `packages/shared/src/index.ts` (export)
- Modify: `packages/shared/src/types/organization.ts` (chaves de settings)

**Interfaces:**
- Produces:
  - Constantes: `SALES_REP_AVAILABILITIES`, `LEAD_ASSIGNMENT_STATUSES`, `LEAD_ASSIGNMENT_REASONS`, `LEAD_EXCEPTION_REASONS`, `LEAD_ACCEPTED_VIA`, `DEFAULT_LEAD_SLA_MINUTES = 15`, `DEFAULT_OWNER_LOOKBACK_DAYS = 30`, `DISTRIBUTION_STRATEGY_VERSION = "round_robin_v1"`
  - Tipos: `SalesRepAvailability`, `SalesRep`, `LeadAssignment`, `DistributionContext`
  - `pickRep(input: PickRepInput): string | null` (id do vendedor)
  - `isHumanOriginMessage(input: HumanOriginInput): boolean`
  - `OrganizationSettings` ganha `lead_distribution_enabled?`, `lead_distribution_activated_at?`, `lead_sla_minutes?`, `owner_lookback_days?`, `business_calendar?`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/lead-distribution.test.ts
import { describe, expect, it } from "vitest";
import { isHumanOriginMessage, pickRep } from "./lead-distribution.js";

const marina = { id: "marina", availability: "available" as const, rotation_order: 1 };
const marcio = { id: "marcio", availability: "available" as const, rotation_order: 2 };

describe("pickRep", () => {
  it("alterna Marina → Márcio → Marina", () => {
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 0 })).toBe("marina");
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 1 })).toBe("marcio");
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 2 })).toBe("marina");
  });
  it("pula quem está pausado ou fora, sem perder a ordem", () => {
    const paused = { ...marcio, availability: "paused" as const };
    expect(pickRep({ reps: [marina, paused], lastRotationOrder: 1 })).toBe("marina");
    const out = { ...marina, availability: "out" as const };
    expect(pickRep({ reps: [out, marcio], lastRotationOrder: 0 })).toBe("marcio");
  });
  it("não devolve ninguém quando não há vendedor disponível", () => {
    expect(pickRep({ reps: [{ ...marina, availability: "paused" }, { ...marcio, availability: "out" }], lastRotationOrder: 0 })).toBeNull();
    expect(pickRep({ reps: [], lastRotationOrder: 0 })).toBeNull();
  });
  it("respeita a lista de excluídos (já recebeu este handoff)", () => {
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 0, excludeRepIds: ["marina"] })).toBe("marcio");
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 0, excludeRepIds: ["marina", "marcio"] })).toBeNull();
  });
  it("ignora peso, limite e especialidade (preparados, não ativos)", () => {
    const weighted = { ...marina, weight: 10, max_active_leads: 0, specialties: ["x"] } as any;
    expect(pickRep({ reps: [weighted, marcio], lastRotationOrder: 0, context: { operation: "financing" } })).toBe("marina");
  });
});

describe("isHumanOriginMessage (6.1.1)", () => {
  const panel = { role: "human_agent", source: "panel" as const, actorUserId: "u1", metadata: null };
  it("mensagem do painel por usuário autenticado é humana", () => {
    expect(isHumanOriginMessage(panel)).toBe(true);
  });
  it("resposta da Mariana (agent) nunca é humana", () => {
    expect(isHumanOriginMessage({ ...panel, role: "agent" })).toBe(false);
  });
  it("mensagens automáticas marcadas não são humanas", () => {
    expect(isHumanOriginMessage({ ...panel, metadata: { low_intent_followup: { stage: 1 } } })).toBe(false);
    expect(isHumanOriginMessage({ ...panel, metadata: { scheduled_ad_closure: { batch_id: "b" } } })).toBe(false);
    expect(isHumanOriginMessage({ ...panel, metadata: { system_generated: true } })).toBe(false);
  });
  it("painel sem usuário autenticado não é humano", () => {
    expect(isHumanOriginMessage({ ...panel, actorUserId: null })).toBe(false);
  });
  it("eco do celular legítimo é humano; eco de mensagem do próprio sistema não", () => {
    const echo = { role: "human_agent", source: "phone_echo" as const, metadata: null };
    expect(isHumanOriginMessage(echo)).toBe(true);
    expect(isHumanOriginMessage({ ...echo, echoMatchedSystemMessage: true })).toBe(false);
  });
  it("saudação curta filtrada pelo celular não assume o lead", () => {
    expect(isHumanOriginMessage({ role: "human_agent", source: "phone_echo", metadata: null, greetingFiltered: true })).toBe(false);
  });
  it("mídia automática marcada não é humana", () => {
    expect(isHumanOriginMessage({ ...panel, metadata: { system_generated: true, tag: "registered_image" } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/shared exec vitest run src/lead-distribution.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/lead-distribution.ts
export const SALES_REP_AVAILABILITIES = ["available", "paused", "out"] as const;
export type SalesRepAvailability = (typeof SALES_REP_AVAILABILITIES)[number];

export const LEAD_ASSIGNMENT_STATUSES = ["pending", "accepted", "expired", "redistributed", "exception"] as const;
export type LeadAssignmentStatus = (typeof LEAD_ASSIGNMENT_STATUSES)[number];

export const LEAD_ASSIGNMENT_REASONS = ["round_robin", "existing_owner", "sla_redistribution", "manual", "bulk_reassignment", "exception"] as const;
export type LeadAssignmentReason = (typeof LEAD_ASSIGNMENT_REASONS)[number];

export const LEAD_EXCEPTION_REASONS = ["no_available_rep", "all_reps_sla_breached", "invalid_existing_owner", "distribution_error", "manual_review"] as const;
export type LeadExceptionReason = (typeof LEAD_EXCEPTION_REASONS)[number];

export const LEAD_ACCEPTED_VIA = ["button", "first_message", "phone_echo", "admin"] as const;
export type LeadAcceptedVia = (typeof LEAD_ACCEPTED_VIA)[number];

export const DEFAULT_LEAD_SLA_MINUTES = 15;
export const DEFAULT_OWNER_LOOKBACK_DAYS = 30;
export const DISTRIBUTION_STRATEGY_VERSION = "round_robin_v1";

export interface SalesRep {
  id: string;
  organization_id: string;
  user_id: string;
  display_name: string;
  availability: SalesRepAvailability;
  availability_changed_at: string;
  rotation_order: number;
  last_assigned_at: string | null;
  // Reservados para o futuro: existem no banco, mas a estratégia atual os ignora.
  weight: number | null;
  max_active_leads: number | null;
  specialties: string[];
  score: number | null;
}

export interface LeadAssignment {
  id: string;
  organization_id: string;
  chain_id: string;
  handoff_event_id: string;
  contact_id: string;
  conversation_id: string;
  opportunity_id: string | null;
  rep_id: string | null;
  reason: LeadAssignmentReason;
  status: LeadAssignmentStatus;
  assigned_at: string;
  handoff_at: string;
  sla_due_at: string | null;
  sla_breached: boolean;
  redistribution_reason: string | null;
  accepted_at: string | null;
  accepted_via: LeadAcceptedVia | null;
  first_human_message_at: string | null;
  first_human_message_by: string | null;
  previous_assignment_id: string | null;
  next_assignment_id: string | null;
  exception_reason: LeadExceptionReason | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  origin_source: string | null;
  operation: string | null;
  product_model: string | null;
  strategy_version: string;
  created_at: string;
}

export interface DistributionContext {
  origin_source?: string | null;
  operation?: string | null;
  product_model?: string | null;
}

export interface PickRepInput {
  reps: Array<Pick<SalesRep, "id" | "availability" | "rotation_order">>;
  lastRotationOrder: number;
  excludeRepIds?: string[];
  /** Hoje ignorado; a estratégia futura (peso, especialidade, origem) lê daqui. */
  context?: DistributionContext;
}

/** Estratégia atual: o próximo vendedor `available` depois do ponteiro, voltando ao início. Espelha o SQL de `distribute_lead`. */
export function pickRep(input: PickRepInput): string | null {
  const excluded = new Set(input.excludeRepIds ?? []);
  const eligible = input.reps
    .filter(r => r.availability === "available" && !excluded.has(r.id))
    .sort((a, b) => a.rotation_order - b.rotation_order);
  if (!eligible.length) return null;
  return (eligible.find(r => r.rotation_order > input.lastRotationOrder) ?? eligible[0]).id;
}

export interface HumanOriginInput {
  role: string;
  source: "panel" | "phone_echo";
  actorUserId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** O eco corresponde a uma mensagem que o próprio sistema enviou (mesmo evolution_message_id). */
  echoMatchedSystemMessage?: boolean;
  /** Saudação curta ("Bom dia") filtrada pelo webhook: não assume atendimento. */
  greetingFiltered?: boolean;
}

// Marcadores gravados em messages.metadata por envios automáticos. Todo remetente automático novo deve usar role "agent" ou um destes.
const AUTOMATION_METADATA_KEYS = ["scheduled_ad_closure", "low_intent_followup", "system_generated"];

/** Só mensagem de origem humana comprovada assume lead ou conta como "primeira resposta humana". */
export function isHumanOriginMessage(i: HumanOriginInput): boolean {
  if (i.role !== "human_agent") return false;
  if (i.echoMatchedSystemMessage) return false;
  const metadata = i.metadata ?? {};
  if (AUTOMATION_METADATA_KEYS.some(key => key in metadata)) return false;
  if (i.source === "panel") return !!i.actorUserId;
  return !i.greetingFiltered;
}
```

Em `packages/shared/src/types/organization.ts`, dentro da interface `OrganizationSettings`, logo depois de `scheduled_ad_closure_batch?`, adicione:

```ts
  // Distribuição de leads (rodízio). Desligada por padrão.
  lead_distribution_enabled?: boolean;
  lead_distribution_activated_at?: string;
  lead_sla_minutes?: number;
  owner_lookback_days?: number;
  business_calendar?: import("../business-calendar.js").BusinessCalendar;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/shared exec vitest run src/lead-distribution.test.ts && pnpm --filter @aula-agente/shared exec tsc --noEmit`
Expected: PASS e sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
echo 'export * from "./lead-distribution.js";' >> packages/shared/src/index.ts
pnpm --filter @aula-agente/shared build
git add packages/shared/src
git commit -m "feat(distribution): pickRep strategy, human-origin rule and shared types"
```

---

### Task 3: Migration 1: esquema, imutabilidade e harness PGlite

**Files:**
- Create: `supabase/migrations/20261007120000_lead_distribution_schema.sql`
- Create: `packages/database/src/sql/fixture.ts`
- Create: `packages/database/src/sql/harness.ts`
- Create: `packages/database/src/sql/lead-distribution-schema.test.ts`
- Modify: `packages/database/package.json` (devDependency)

**Interfaces:**
- Produces: tabelas `sales_reps`, `lead_distribution_state`, `lead_assignments`; colunas `conversations.assigned_at`, `opportunities.owner_assigned_at`, `opportunities.last_commercial_activity_at`; view `lead_response_metrics`; helper de teste `createTestDb()` e `seed*` usados pelas Tasks 4 e 5.

- [ ] **Step 1: Add the test dependency**

Run: `pnpm --filter @aula-agente/database add -D @electric-sql/pglite`
Expected: `package.json` do pacote ganha a devDependency.

- [ ] **Step 2: Write the fixture and harness**

```ts
// packages/database/src/sql/fixture.ts
// Esquema mínimo das tabelas existentes que as funções novas leem/escrevem. Só para testes.
export const FIXTURE_SQL = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings jsonb NOT NULL DEFAULT '{}');
CREATE TABLE public.organization_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid NOT NULL, role text NOT NULL DEFAULT 'agent');
CREATE TABLE public.wa_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id));
CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id), assigned_to uuid, is_human_takeover boolean NOT NULL DEFAULT false);
CREATE TABLE public.opportunities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id), status text NOT NULL DEFAULT 'open', stage text NOT NULL DEFAULT 'interest_received', owner_id uuid, operation text, product_model text);
CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id), status text NOT NULL DEFAULT 'pending', assignee_type text, assignee_id uuid);
CREATE TABLE public.handoff_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id), trigger_type text NOT NULL DEFAULT 'request_human', handed_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid WHERE false $$;
`;
```

```ts
// packages/database/src/sql/harness.ts
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { FIXTURE_SQL } from "./fixture.js";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

export async function createTestDb(files: string[] = [
  "20261007120000_lead_distribution_schema.sql",
  "20261007120100_lead_distribution_assign.sql",
  "20261007120200_lead_distribution_lifecycle.sql",
]) {
  const db = new PGlite();
  await db.exec(FIXTURE_SQL);
  for (const file of files) {
    let sql: string;
    try { sql = readFileSync(new URL(file, MIGRATIONS), "utf8"); } catch { continue; } // tasks 4 e 5 criam os demais arquivos
    await db.exec(sql);
  }
  return db;
}

type Db = Awaited<ReturnType<typeof createTestDb>>;
export const uuid = async (db: Db) => (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;

export async function seedOrg(db: Db, settings: Record<string, unknown> = { lead_distribution_enabled: true }) {
  return (await db.query<{ id: string }>("insert into public.organizations(settings) values ($1) returning id", [JSON.stringify(settings)])).rows[0].id;
}

/** Cria um vendedor: membro da organização + linha em sales_reps. rotation_order define a vez. */
export async function seedRep(db: Db, orgId: string, name: string, order: number, availability = "available", member = true) {
  const userId = await uuid(db);
  if (member) await db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'agent')", [orgId, userId]);
  const repId = (await db.query<{ id: string }>(
    "insert into public.sales_reps(organization_id,user_id,display_name,availability,rotation_order) values ($1,$2,$3,$4,$5) returning id",
    [orgId, userId, name, availability, order])).rows[0].id;
  return { repId, userId };
}

/** Contato + conversa + evento de handoff (request_human). */
export async function seedHandoff(db: Db, orgId: string, handedAt = new Date().toISOString()) {
  const contactId = (await db.query<{ id: string }>("insert into public.wa_contacts(organization_id) values ($1) returning id", [orgId])).rows[0].id;
  const conversationId = (await db.query<{ id: string }>("insert into public.conversations(organization_id,contact_id) values ($1,$2) returning id", [orgId, contactId])).rows[0].id;
  const handoffId = (await db.query<{ id: string }>("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [orgId, conversationId, handedAt])).rows[0].id;
  return { contactId, conversationId, handoffId };
}

export const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
```

- [ ] **Step 3: Write the failing test**

```ts
// packages/database/src/sql/lead-distribution-schema.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(["20261007120000_lead_distribution_schema.sql"]); });

async function insertAssignment(orgId: string, h: Awaited<ReturnType<typeof seedHandoff>>, repId: string, extra: Record<string, unknown> = {}) {
  const row = {
    chain_id: crypto.randomUUID(), reason: "round_robin", status: "pending", sla_due_at: inMinutes(15), ...extra,
  };
  return (await db.query<{ id: string }>(
    `insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,handoff_at,sla_due_at,strategy_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,'round_robin_v1') returning id`,
    [orgId, row.chain_id, h.handoffId, h.contactId, h.conversationId, repId, row.reason, row.status, row.sla_due_at])).rows[0].id;
}

describe("lead_assignments schema", () => {
  it("permite uma única atribuição ativa por conversa", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await insertAssignment(org, h, a.repId);
    await expect(insertAssignment(org, h, b.repId)).rejects.toThrow();
  });

  it("impede o mesmo vendedor duas vezes na mesma cadeia automática", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const chain = crypto.randomUUID();
    const first = await insertAssignment(org, h, a.repId, { chain_id: chain, status: "expired" });
    expect(first).toBeTruthy();
    await expect(insertAssignment(org, h, a.repId, { chain_id: chain, reason: "sla_redistribution" })).rejects.toThrow();
  });

  it("permite repetir o vendedor em atribuição manual (decisão do gestor)", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const chain = crypto.randomUUID();
    await insertAssignment(org, h, a.repId, { chain_id: chain, status: "expired" });
    await expect(insertAssignment(org, h, a.repId, { chain_id: chain, reason: "manual" })).resolves.toBeTruthy();
  });

  it("exige rep_id nulo exatamente quando o estado é exceção", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    await expect(db.query(
      `insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,handoff_at,strategy_version)
       values ($1,gen_random_uuid(),$2,$3,$4,null,'exception','pending',now(),'round_robin_v1')`,
      [org, h.handoffId, h.contactId, h.conversationId])).rejects.toThrow();
  });
});

describe("imutabilidade do histórico", () => {
  it("rejeita DELETE e mudança de campos protegidos", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); const id = await insertAssignment(org, h, a.repId);
    await expect(db.query("delete from public.lead_assignments where id=$1", [id])).rejects.toThrow(/imut/i);
    await expect(db.query("update public.lead_assignments set rep_id=$2 where id=$1", [id, b.repId])).rejects.toThrow(/imut/i);
    await expect(db.query("update public.lead_assignments set reason='manual' where id=$1", [id])).rejects.toThrow(/imut/i);
    await expect(db.query("update public.lead_assignments set assigned_at=now() - interval '1 day' where id=$1", [id])).rejects.toThrow(/imut/i);
    await expect(db.query("update public.lead_assignments set handoff_at=now() where id=$1", [id])).rejects.toThrow(/imut/i);
  });

  it("permite avançar o estado e registrar aceite", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await insertAssignment(org, h, a.repId);
    await db.query("update public.lead_assignments set status='accepted', accepted_at=now(), accepted_via='button' where id=$1", [id]);
    const row = (await db.query<any>("select status, accepted_via from public.lead_assignments where id=$1", [id])).rows[0];
    expect(row).toMatchObject({ status: "accepted", accepted_via: "button" });
  });

  it("next_assignment_id só pode ser preenchido uma vez", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); const chain = crypto.randomUUID();
    const one = await insertAssignment(org, h, a.repId, { chain_id: chain, status: "expired" });
    const two = await insertAssignment(org, h, b.repId, { chain_id: chain, reason: "sla_redistribution" });
    await db.query("update public.lead_assignments set next_assignment_id=$2 where id=$1", [one, two]);
    await expect(db.query("update public.lead_assignments set next_assignment_id=$2 where id=$1", [one, one])).rejects.toThrow(/imut/i);
  });
});

describe("lead_response_metrics", () => {
  it("calcula os três intervalos de tempo", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await insertAssignment(org, h, a.repId);
    await db.query(
      `update public.lead_assignments set accepted_at = assigned_at + interval '120 seconds', accepted_via='button', status='accepted',
         first_human_message_at = assigned_at + interval '300 seconds' where id=$1`, [id]);
    const m = (await db.query<any>("select * from public.lead_response_metrics where assignment_id=$1", [id])).rows[0];
    expect(m.assigned_to_accepted_seconds).toBe(120);
    expect(m.assigned_to_first_human_seconds).toBe(300);
    expect(m.handoff_to_first_human_seconds).toBeGreaterThanOrEqual(300);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/lead-distribution-schema.test.ts`
Expected: FAIL (arquivo de migration inexistente).

- [ ] **Step 5: Write the migration**

```sql
-- supabase/migrations/20261007120000_lead_distribution_schema.sql
-- Distribuição de leads (rodízio): dados, imutabilidade e métricas. Sem efeito enquanto
-- organizations.settings.lead_distribution_enabled não for true.

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS owner_assigned_at timestamptz;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS last_commercial_activity_at timestamptz;

CREATE TABLE public.sales_reps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  display_name text NOT NULL,
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','paused','out')),
  availability_changed_at timestamptz NOT NULL DEFAULT now(),
  rotation_order integer NOT NULL,
  -- Só auditoria: NÃO decide quem é o próximo (isso é lead_distribution_state.last_rotation_order).
  last_assigned_at timestamptz,
  -- Reservados para o futuro; a estratégia atual os ignora.
  weight numeric,
  max_active_leads integer,
  specialties text[] NOT NULL DEFAULT '{}',
  score numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, rotation_order)
);

CREATE TABLE public.lead_distribution_state (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_rotation_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lead_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  chain_id uuid NOT NULL,
  handoff_event_id uuid NOT NULL REFERENCES public.handoff_events(id),
  contact_id uuid NOT NULL REFERENCES public.wa_contacts(id),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id),
  opportunity_id uuid REFERENCES public.opportunities(id),
  rep_id uuid REFERENCES public.sales_reps(id),
  reason text NOT NULL CHECK (reason IN ('round_robin','existing_owner','sla_redistribution','manual','bulk_reassignment','exception')),
  status text NOT NULL CHECK (status IN ('pending','accepted','expired','redistributed','exception')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  handoff_at timestamptz NOT NULL,
  sla_due_at timestamptz,
  sla_breached boolean NOT NULL DEFAULT false,
  redistribution_reason text,
  accepted_at timestamptz,
  accepted_via text CHECK (accepted_via IN ('button','first_message','phone_echo','admin')),
  first_human_message_at timestamptz,
  first_human_message_by uuid,
  previous_assignment_id uuid REFERENCES public.lead_assignments(id),
  next_assignment_id uuid REFERENCES public.lead_assignments(id),
  exception_reason text CHECK (exception_reason IN ('no_available_rep','all_reps_sla_breached','invalid_existing_owner','distribution_error','manual_review')),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution text,
  origin_source text,
  operation text,
  product_model text,
  strategy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'exception') = (rep_id IS NULL)),
  CHECK ((status = 'exception') = (exception_reason IS NOT NULL))
);

-- No máximo uma atribuição ativa por conversa.
CREATE UNIQUE INDEX lead_assignments_one_active_per_conversation ON public.lead_assignments (conversation_id) WHERE status IN ('pending','accepted');
-- Cada vendedor recebe o mesmo handoff no máximo uma vez nas atribuições automáticas (sem vai e volta).
CREATE UNIQUE INDEX lead_assignments_one_rep_per_chain ON public.lead_assignments (chain_id, rep_id) WHERE rep_id IS NOT NULL AND reason IN ('round_robin','existing_owner','sla_redistribution');
-- Idempotência: um handoff abre uma única cadeia.
CREATE UNIQUE INDEX lead_assignments_one_chain_per_handoff ON public.lead_assignments (handoff_event_id) WHERE previous_assignment_id IS NULL;
CREATE INDEX lead_assignments_sla_due ON public.lead_assignments (sla_due_at) WHERE status = 'pending';
CREATE INDEX lead_assignments_open_exceptions ON public.lead_assignments (organization_id) WHERE status = 'exception' AND resolved_at IS NULL;
CREATE INDEX lead_assignments_contact ON public.lead_assignments (organization_id, contact_id, assigned_at DESC);

-- Histórico imutável: nunca DELETE; campos de identidade nunca mudam.
CREATE FUNCTION public.lead_assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lead_assignments é imutável: não apague o histórico'; END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
     OR NEW.handoff_event_id IS DISTINCT FROM OLD.handoff_event_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.rep_id IS DISTINCT FROM OLD.rep_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
     OR NEW.handoff_at IS DISTINCT FROM OLD.handoff_at
     OR NEW.previous_assignment_id IS DISTINCT FROM OLD.previous_assignment_id
     OR NEW.strategy_version IS DISTINCT FROM OLD.strategy_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'lead_assignments é imutável: campo protegido';
  END IF;
  IF OLD.next_assignment_id IS NOT NULL AND NEW.next_assignment_id IS DISTINCT FROM OLD.next_assignment_id THEN
    RAISE EXCEPTION 'lead_assignments é imutável: next_assignment_id já definido';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_assignments_guard_update BEFORE UPDATE ON public.lead_assignments FOR EACH ROW EXECUTE FUNCTION public.lead_assignments_guard();
CREATE TRIGGER lead_assignments_guard_delete BEFORE DELETE ON public.lead_assignments FOR EACH ROW EXECUTE FUNCTION public.lead_assignments_guard();

-- Leitura por organização, como as demais tabelas. Escrita só por service_role (as funções SECURITY DEFINER).
-- O isolamento por vendedor, nesta fase, é da aplicação (fase 2 da spec trata RLS por vendedor).
ALTER TABLE public.sales_reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_distribution_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_reps_select ON public.sales_reps FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY lead_distribution_state_select ON public.lead_distribution_state FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY lead_assignments_select ON public.lead_assignments FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));

-- KPIs de tempo. handoff_at é herdado em toda redistribuição: o tempo handoff → primeira resposta cobre a cadeia inteira.
CREATE VIEW public.lead_response_metrics WITH (security_invoker = true) AS
SELECT a.id AS assignment_id, a.organization_id, a.chain_id, a.rep_id, a.reason, a.status, a.sla_breached,
       a.handoff_at, a.assigned_at, a.accepted_at, a.first_human_message_at,
       EXTRACT(EPOCH FROM (a.first_human_message_at - a.handoff_at))::integer AS handoff_to_first_human_seconds,
       EXTRACT(EPOCH FROM (a.first_human_message_at - a.assigned_at))::integer AS assigned_to_first_human_seconds,
       EXTRACT(EPOCH FROM (a.accepted_at - a.assigned_at))::integer AS assigned_to_accepted_seconds
FROM public.lead_assignments a
WHERE a.rep_id IS NOT NULL AND a.reason <> 'bulk_reassignment';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/lead-distribution-schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261007120000_lead_distribution_schema.sql packages/database/src/sql packages/database/package.json pnpm-lock.yaml
git commit -m "feat(distribution): schema, immutability trigger and PGlite harness"
```

---

### Task 4: Migration 2: precedência do dono e `distribute_lead`

**Files:**
- Create: `supabase/migrations/20261007120100_lead_distribution_assign.sql`
- Create: `packages/database/src/sql/lead-distribution-assign.test.ts`

**Interfaces:**
- Consumes: Task 3 (tabelas e helpers de teste).
- Produces (SQL):
  - `public._lead_owner_check(p_org uuid, p_user uuid) RETURNS TABLE(rep_id uuid, state text)` onde `state ∈ {'not_rep','valid','out','invalid'}`
  - `public.resolve_current_owner(p_org uuid, p_contact uuid, p_conversation uuid, p_lookback_days integer) RETURNS TABLE(rep_id uuid, outcome text)` onde `outcome ∈ {'found','none','conflict','invalid'}`
  - `public._lead_apply_effects(p_org uuid, p_conversation uuid, p_contact uuid, p_user uuid) RETURNS uuid` (devolve o id do negócio ligado, se houver um só)
  - `public.distribute_lead(p_organization_id uuid, p_conversation_id uuid, p_handoff_event_id uuid, p_sla_due_at timestamptz, p_context jsonb DEFAULT '{}') RETURNS uuid` (id da atribuição; `NULL` se a flag estiver desligada ou o handoff for anterior à ativação)

- [ ] **Step 1: Write the failing test**

```ts
// packages/database/src/sql/lead-distribution-assign.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(); });

const distribute = async (org: string, h: { conversationId: string; handoffId: string }, due = inMinutes(15)) =>
  (await db.query<{ id: string | null }>("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, due])).rows[0].id;
const row = async (id: string) => (await db.query<any>("select a.*, r.display_name from public.lead_assignments a left join public.sales_reps r on r.id=a.rep_id where a.id=$1", [id])).rows[0];

describe("distribute_lead: rodízio", () => {
  it("alterna Marina → Márcio → Marina → Márcio", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const names: string[] = [];
    for (let i = 0; i < 4; i++) names.push((await row((await distribute(org, await seedHandoff(db, org)))!)).display_name);
    expect(names).toEqual(["Marina", "Márcio", "Marina", "Márcio"]);
  });

  it("pula o pausado e o fora sem perder a ordem", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2, "paused");
    const first = await row((await distribute(org, await seedHandoff(db, org)))!);
    const second = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect([first.display_name, second.display_name]).toEqual(["Marina", "Marina"]);
    await db.query("update public.sales_reps set availability='available' where organization_id=$1 and display_name='Márcio'", [org]);
    const third = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect(third.display_name).toBe("Márcio"); // volta sem rajada de compensação
    const fourth = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect(fourth.display_name).toBe("Marina");
    expect(marina.repId).toBeTruthy();
  });

  it("mantém o ponteiro no banco: last_rotation_order é a fonte do próximo", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    await distribute(org, await seedHandoff(db, org));
    expect((await db.query<any>("select last_rotation_order from public.lead_distribution_state where organization_id=$1", [org])).rows[0].last_rotation_order).toBe(1);
    // alterar só last_assigned_at não muda quem é o próximo
    await db.query("update public.sales_reps set last_assigned_at = now() + interval '1 day' where display_name='Márcio'");
    expect((await row((await distribute(org, await seedHandoff(db, org)))!)).display_name).toBe("Márcio");
  });
});

describe("distribute_lead: efeitos, contexto e idempotência", () => {
  it("grava dono na conversa, no negócio único aberto e nas tarefas abertas", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    const opp = (await db.query<any>("insert into public.opportunities(organization_id,contact_id,operation,product_model) values ($1,$2,'consortium','Fazer 250') returning id", [org, h.contactId])).rows[0].id;
    await db.query("insert into public.tasks(organization_id,contact_id,status) values ($1,$2,'pending')", [org, h.contactId]);
    const id = (await distribute(org, h))!;
    const a = await row(id);
    expect(a).toMatchObject({ reason: "round_robin", status: "pending", opportunity_id: opp, operation: null });
    const conv = (await db.query<any>("select assigned_to, assigned_at from public.conversations where id=$1", [h.conversationId])).rows[0];
    expect(conv.assigned_to).toBe(marina.userId); expect(conv.assigned_at).not.toBeNull();
    const o = (await db.query<any>("select owner_id, owner_assigned_at from public.opportunities where id=$1", [opp])).rows[0];
    expect(o.owner_id).toBe(marina.userId); expect(o.owner_assigned_at).not.toBeNull();
    expect((await db.query<any>("select assignee_id, assignee_type from public.tasks where contact_id=$1", [h.contactId])).rows[0]).toEqual({ assignee_id: marina.userId, assignee_type: "human" });
  });

  it("copia o contexto recebido para análises futuras", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const h = await seedHandoff(db, org);
    const id = (await db.query<any>("select public.distribute_lead($1,$2,$3,$4,$5::jsonb) as id", [org, h.conversationId, h.handoffId, inMinutes(15), JSON.stringify({ origin_source: "anuncio", operation: "financing", product_model: "Factor" })])).rows[0].id;
    expect(await row(id)).toMatchObject({ origin_source: "anuncio", operation: "financing", product_model: "Factor", strategy_version: "round_robin_v1" });
  });

  it("é idempotente por handoff_event_id (reprocessamento não duplica)", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const one = await distribute(org, h); const two = await distribute(org, h);
    expect(two).toBe(one);
    expect((await db.query<any>("select count(*)::int as n from public.lead_assignments")).rows[0].n).toBe(1);
    expect((await db.query<any>("select last_rotation_order from public.lead_distribution_state")).rows[0].last_rotation_order).toBe(1);
  });

  it("não faz nada com a flag desligada nem para handoff anterior à ativação", async () => {
    const off = await seedOrg(db, {}); await seedRep(db, off, "Marina", 1);
    expect(await distribute(off, await seedHandoff(db, off))).toBeNull();
    const org = await seedOrg(db, { lead_distribution_enabled: true, lead_distribution_activated_at: "2026-10-07T12:00:00Z" });
    await seedRep(db, org, "Marina", 1);
    expect(await distribute(org, await seedHandoff(db, org, "2026-10-07T11:00:00Z"))).toBeNull();
    expect(await distribute(org, await seedHandoff(db, org, "2026-10-07T13:00:00Z"))).not.toBeNull();
  });

  it("segundo handoff enquanto há atribuição ativa devolve a mesma atribuição", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    const first = await distribute(org, h);
    const again = (await db.query<any>("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2) returning id", [org, h.conversationId])).rows[0].id;
    expect(await distribute(org, { conversationId: h.conversationId, handoffId: again })).toBe(first);
  });
});

describe("distribute_lead: dono existente (precedência)", () => {
  it("negócio aberto atual vence; o rodízio não avança", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h.contactId, marcio.userId]);
    const a = await row((await distribute(org, h))!);
    expect(a).toMatchObject({ display_name: "Márcio", reason: "existing_owner" });
    expect((await db.query<any>("select last_rotation_order from public.lead_distribution_state")).rows[0].last_rotation_order).toBe(0);
  });

  it("conversa atual vale quando não há negócio aberto com dono", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("update public.conversations set assigned_to=$2 where id=$1", [h.conversationId, marcio.userId]);
    expect((await row((await distribute(org, h))!)).display_name).toBe("Márcio");
  });

  it("dono pausado mantém o cliente; dono fora volta ao rodízio só neste handoff", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1, "paused"); await seedRep(db, org, "Márcio", 2);
    const h1 = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h1.contactId, marina.userId]);
    expect(await row((await distribute(org, h1))!)).toMatchObject({ display_name: "Marina", reason: "existing_owner" });
    await db.query("update public.sales_reps set availability='out' where id=$1", [marina.repId]);
    const h2 = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h2.contactId, marina.userId]);
    expect(await row((await distribute(org, h2))!)).toMatchObject({ display_name: "Márcio", reason: "round_robin" });
  });

  it("dono que não é vendedor (conta compartilhada/legado) é ignorado", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,gen_random_uuid())", [org, h.contactId]);
    expect((await row((await distribute(org, h))!)).reason).toBe("round_robin");
  });

  it("negócio perdido antigo não prende o cliente ao vendedor", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id,status) values ($1,$2,$3,'lost')", [org, h.contactId, marina.userId]);
    expect((await row((await distribute(org, h))!)).reason).toBe("round_robin");
  });

  it("último responsável vale só dentro da janela de 30 dias", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const old = await seedHandoff(db, org);
    const prev = (await distribute(org, old))!; // Marina (round_robin)
    await db.query("update public.lead_assignments set status='accepted', accepted_at=now() - interval '10 days', accepted_via='button' where id=$1", [prev]);
    await db.query("update public.conversations set assigned_to=null where id=$1", [old.conversationId]);
    const again = await seedHandoff(db, org); // outra conversa do mesmo contato
    await db.query("update public.conversations set contact_id=$2 where id=$1", [again.conversationId, old.contactId]);
    expect(await row((await distribute(org, { conversationId: again.conversationId, handoffId: again.handoffId }))!)).toMatchObject({ display_name: "Marina", reason: "existing_owner" });
    expect(marina.repId && marcio.repId).toBeTruthy();
  });
});

describe("distribute_lead: exceções", () => {
  it("sem nenhum vendedor disponível cria exceção no_available_rep e não quebra", async () => {
    const org = await seedOrg(db); // zero vendedores cadastrados
    const a = await row((await distribute(org, await seedHandoff(db, org)))!);
    expect(a).toMatchObject({ status: "exception", exception_reason: "no_available_rep", rep_id: null });
  });

  it("vendedor removido da organização que ainda é dono vira invalid_existing_owner", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const gone = await seedRep(db, org, "Ex-vendedor", 2, "available", false); // sem organization_members
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [org, h.contactId, gone.userId]);
    expect(await row((await distribute(org, h))!)).toMatchObject({ status: "exception", exception_reason: "invalid_existing_owner" });
  });

  it("donos de vendedores diferentes em negócios abertos viram manual_review", async () => {
    const org = await seedOrg(db); const a = await seedRep(db, org, "Marina", 1); const b = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3),($1,$2,$4)", [org, h.contactId, a.userId, b.userId]);
    expect(await row((await distribute(org, h))!)).toMatchObject({ status: "exception", exception_reason: "manual_review" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/lead-distribution-assign.test.ts`
Expected: FAIL (função `distribute_lead` inexistente).

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261007120100_lead_distribution_assign.sql
CREATE FUNCTION public._lead_owner_check(p_org uuid, p_user uuid)
RETURNS TABLE(rep_id uuid, state text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.sales_reps;
BEGIN
  IF p_user IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'not_rep'::text; RETURN; END IF;
  SELECT * INTO r FROM public.sales_reps WHERE organization_id = p_org AND user_id = p_user;
  IF r.id IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'not_rep'::text; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = p_org AND m.user_id = p_user) THEN
    RETURN QUERY SELECT r.id, 'invalid'::text; RETURN;
  END IF;
  IF r.availability = 'out' THEN RETURN QUERY SELECT r.id, 'out'::text; RETURN; END IF;
  RETURN QUERY SELECT r.id, 'valid'::text;
END $$;

-- Precedência: negócio aberto atual > conversa atual > último responsável válido (dentro da janela).
CREATE FUNCTION public.resolve_current_owner(p_org uuid, p_contact uuid, p_conversation uuid, p_lookback_days integer)
RETURNS TABLE(rep_id uuid, outcome text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; chk record; valid_ids uuid[] := '{}'; invalid_id uuid; out_id uuid; conv_user uuid; last_user uuid;
BEGIN
  -- 1. Negócios abertos do contato
  FOR o IN SELECT DISTINCT owner_id FROM public.opportunities WHERE organization_id = p_org AND contact_id = p_contact AND status = 'open' AND owner_id IS NOT NULL LOOP
    SELECT * INTO chk FROM public._lead_owner_check(p_org, o.owner_id);
    IF chk.state = 'valid' THEN valid_ids := array_append(valid_ids, chk.rep_id);
    ELSIF chk.state = 'invalid' THEN invalid_id := chk.rep_id;
    ELSIF chk.state = 'out' THEN out_id := chk.rep_id; END IF;
  END LOOP;
  IF array_length(valid_ids, 1) > 1 THEN RETURN QUERY SELECT NULL::uuid, 'conflict'::text; RETURN; END IF;
  IF array_length(valid_ids, 1) = 1 THEN RETURN QUERY SELECT valid_ids[1], 'found'::text; RETURN; END IF;
  IF invalid_id IS NOT NULL THEN RETURN QUERY SELECT invalid_id, 'invalid'::text; RETURN; END IF;
  IF out_id IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, 'none'::text; RETURN; END IF;

  -- 2. Conversa atual
  SELECT assigned_to INTO conv_user FROM public.conversations WHERE id = p_conversation AND organization_id = p_org;
  SELECT * INTO chk FROM public._lead_owner_check(p_org, conv_user);
  IF chk.state = 'valid' THEN RETURN QUERY SELECT chk.rep_id, 'found'::text; RETURN; END IF;
  IF chk.state = 'invalid' THEN RETURN QUERY SELECT chk.rep_id, 'invalid'::text; RETURN; END IF;
  IF chk.state = 'out' THEN RETURN QUERY SELECT NULL::uuid, 'none'::text; RETURN; END IF;

  -- 3. Último responsável válido: atribuição aceita dentro da janela (aceite ou atividade comercial recente)
  SELECT r.user_id INTO last_user
    FROM public.lead_assignments a
    JOIN public.sales_reps r ON r.id = a.rep_id
    LEFT JOIN public.opportunities op ON op.id = a.opportunity_id
   WHERE a.organization_id = p_org AND a.contact_id = p_contact AND a.status = 'accepted'
     AND GREATEST(a.accepted_at, op.last_commercial_activity_at) >= now() - make_interval(days => p_lookback_days)
   ORDER BY GREATEST(a.accepted_at, op.last_commercial_activity_at) DESC NULLS LAST LIMIT 1;
  SELECT * INTO chk FROM public._lead_owner_check(p_org, last_user);
  IF chk.state = 'valid' THEN RETURN QUERY SELECT chk.rep_id, 'found'::text; RETURN; END IF;
  RETURN QUERY SELECT NULL::uuid, 'none'::text;
END $$;

-- Aplica a atribuição às tabelas operacionais. Devolve o negócio ligado (se houver exatamente um aberto).
CREATE FUNCTION public._lead_apply_effects(p_org uuid, p_conversation uuid, p_contact uuid, p_user uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE opp_count integer; opp_id uuid;
BEGIN
  UPDATE public.conversations SET assigned_to = p_user, assigned_at = now() WHERE id = p_conversation AND organization_id = p_org;
  SELECT count(*), min(id::text)::uuid INTO opp_count, opp_id FROM public.opportunities WHERE organization_id = p_org AND contact_id = p_contact AND status = 'open';
  IF opp_count = 1 THEN
    UPDATE public.opportunities
       SET owner_assigned_at = CASE WHEN owner_id IS DISTINCT FROM p_user THEN now() ELSE owner_assigned_at END,
           owner_id = p_user
     WHERE id = opp_id;
  ELSE opp_id := NULL; END IF;
  UPDATE public.tasks SET assignee_type = 'human', assignee_id = p_user
   WHERE organization_id = p_org AND contact_id = p_contact AND status IN ('pending','in_progress','rescheduled');
  RETURN opp_id;
END $$;

CREATE FUNCTION public.distribute_lead(p_organization_id uuid, p_conversation_id uuid, p_handoff_event_id uuid, p_sla_due_at timestamptz, p_context jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s jsonb; h public.handoff_events; c public.conversations; st public.lead_distribution_state;
  existing uuid; chain uuid := gen_random_uuid(); owner record; rep public.sales_reps;
  lookback integer; reason text; exc text; new_id uuid; opp_id uuid; user_id uuid;
BEGIN
  SELECT settings INTO s FROM public.organizations WHERE id = p_organization_id;
  IF s IS NULL OR s->>'lead_distribution_enabled' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.handoff_events WHERE id = p_handoff_event_id AND organization_id = p_organization_id AND conversation_id = p_conversation_id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'Handoff inexistente para esta conversa'; END IF;
  IF s->>'lead_distribution_activated_at' IS NOT NULL AND h.handed_at < (s->>'lead_distribution_activated_at')::timestamptz THEN RETURN NULL; END IF;

  -- Trava por organização: serializa as atribuições e protege o ponteiro do rodízio.
  INSERT INTO public.lead_distribution_state (organization_id) VALUES (p_organization_id) ON CONFLICT DO NOTHING;
  SELECT * INTO st FROM public.lead_distribution_state WHERE organization_id = p_organization_id FOR UPDATE;

  SELECT id INTO existing FROM public.lead_assignments WHERE handoff_event_id = p_handoff_event_id AND previous_assignment_id IS NULL;
  IF existing IS NOT NULL THEN RETURN existing; END IF;
  SELECT id INTO existing FROM public.lead_assignments WHERE conversation_id = p_conversation_id AND status IN ('pending','accepted');
  IF existing IS NOT NULL THEN RETURN existing; END IF;

  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id AND organization_id = p_organization_id;
  lookback := COALESCE(NULLIF(s->>'owner_lookback_days', '')::integer, 30);
  SELECT * INTO owner FROM public.resolve_current_owner(p_organization_id, c.contact_id, c.id, lookback);

  IF owner.outcome = 'found' THEN
    SELECT * INTO rep FROM public.sales_reps WHERE id = owner.rep_id; reason := 'existing_owner';
  ELSIF owner.outcome = 'conflict' THEN exc := 'manual_review';
  ELSIF owner.outcome = 'invalid' THEN exc := 'invalid_existing_owner';
  ELSE
    -- Rodízio: primeiro disponível depois do ponteiro; se não houver, volta ao início.
    SELECT r.* INTO rep FROM public.sales_reps r
     WHERE r.organization_id = p_organization_id AND r.availability = 'available'
       AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id)
     ORDER BY (r.rotation_order > st.last_rotation_order) DESC, r.rotation_order LIMIT 1;
    IF rep.id IS NULL THEN exc := 'no_available_rep';
    ELSE
      reason := 'round_robin';
      UPDATE public.lead_distribution_state SET last_rotation_order = rep.rotation_order, updated_at = now() WHERE organization_id = p_organization_id;
      UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = rep.id;
    END IF;
  END IF;

  IF exc IS NOT NULL THEN
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, rep_id, reason, status, handoff_at, exception_reason,
                                         origin_source, operation, product_model, strategy_version)
    VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, NULL, 'exception', 'exception', h.handed_at, exc,
            p_context->>'origin_source', p_context->>'operation', p_context->>'product_model', 'round_robin_v1')
    RETURNING id INTO new_id;
    RETURN new_id;
  END IF;

  opp_id := public._lead_apply_effects(p_organization_id, c.id, c.contact_id, rep.user_id);
  INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at,
                                       origin_source, operation, product_model, strategy_version)
  VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, opp_id, rep.id, reason, 'pending', h.handed_at, p_sla_due_at,
          p_context->>'origin_source', p_context->>'operation', p_context->>'product_model', 'round_robin_v1')
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION public._lead_owner_check(uuid, uuid), public.resolve_current_owner(uuid, uuid, uuid, integer),
  public._lead_apply_effects(uuid, uuid, uuid, uuid), public.distribute_lead(uuid, uuid, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._lead_owner_check(uuid, uuid), public.resolve_current_owner(uuid, uuid, uuid, integer),
  public._lead_apply_effects(uuid, uuid, uuid, uuid), public.distribute_lead(uuid, uuid, uuid, timestamptz, jsonb) TO service_role;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql`
Expected: PASS em `lead-distribution-schema` e `lead-distribution-assign`. Se um teste falhar por detalhe de PGlite (por exemplo `min(id::text)::uuid`), corrija a função, não o teste. A semântica testada é a da spec.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261007120100_lead_distribution_assign.sql packages/database/src/sql/lead-distribution-assign.test.ts
git commit -m "feat(distribution): owner precedence and atomic distribute_lead"
```

---

### Task 5: Migration 3: SLA, aceite, mensagem humana e reatribuição manual

**Files:**
- Create: `supabase/migrations/20261007120200_lead_distribution_lifecycle.sql`
- Create: `packages/database/src/sql/lead-distribution-lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 3 e 4.
- Produces (SQL, todas `SECURITY DEFINER`, só `service_role`):
  - `public.redistribute_assignment(p_assignment_id uuid, p_new_sla_due_at timestamptz) RETURNS uuid` (id da nova atribuição ou da exceção; `NULL` se não estava vencida/pendente)
  - `public.accept_assignment(p_assignment_id uuid, p_actor uuid, p_actor_is_admin boolean) RETURNS boolean`
  - `public.record_human_message(p_organization_id uuid, p_conversation_id uuid, p_at timestamptz, p_author uuid, p_via text) RETURNS uuid` (`p_via ∈ {'panel','phone_echo'}`; `NULL` se não há atribuição ativa)
  - `public.manual_assign(p_organization_id uuid, p_conversation_id uuid, p_rep_id uuid, p_actor uuid, p_sla_due_at timestamptz) RETURNS uuid`

- [ ] **Step 1: Write the failing test**

```ts
// packages/database/src/sql/lead-distribution-lifecycle.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep, uuid } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(); });

const distribute = async (org: string, h: { conversationId: string; handoffId: string }, due = inMinutes(15)) =>
  (await db.query<{ id: string }>("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, due])).rows[0].id;
const row = async (id: string) => (await db.query<any>("select a.*, r.display_name from public.lead_assignments a left join public.sales_reps r on r.id=a.rep_id where a.id=$1", [id])).rows[0];
const redistribute = async (id: string, due = inMinutes(15)) =>
  (await db.query<{ id: string | null }>("select public.redistribute_assignment($1,$2) as id", [id, due])).rows[0].id;
const past = () => new Date(Date.now() - 60_000).toISOString();

describe("redistribute_assignment", () => {
  it("não faz nada enquanto o SLA não venceu", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org), inMinutes(10));
    expect(await redistribute(id)).toBeNull();
    expect((await row(id)).status).toBe("pending");
  });

  it("vencido: marca estourou, cria atribuição ao outro vendedor e liga as duas, sem apagar nada", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); const first = await distribute(org, h, past());
    const next = (await redistribute(first))!;
    const a = await row(first); const b = await row(next);
    expect(a).toMatchObject({ status: "expired", sla_breached: true, redistribution_reason: "sla_expired", next_assignment_id: next, display_name: "Marina" });
    expect(b).toMatchObject({ status: "pending", reason: "sla_redistribution", previous_assignment_id: first, display_name: "Márcio", chain_id: a.chain_id });
    expect(b.handoff_at.toISOString()).toBe(a.handoff_at.toISOString()); // KPI cobre a cadeia inteira
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marcio.userId);
    expect((await db.query<any>("select count(*)::int as n from public.lead_assignments")).rows[0].n).toBe(2);
  });

  it("move o ponteiro para quem recebeu, então o próximo lead novo vai ao outro vendedor", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    await redistribute(await distribute(org, await seedHandoff(db, org), past())); // Marina → Márcio
    expect((await row(await distribute(org, await seedHandoff(db, org)))).display_name).toBe("Marina");
  });

  it("sem vai e volta: se o segundo também estourar, vira exceção all_reps_sla_breached", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const first = await distribute(org, await seedHandoff(db, org), past());
    const second = (await redistribute(first, past()))!;
    const third = (await redistribute(second))!;
    expect(await row(third)).toMatchObject({ status: "exception", exception_reason: "all_reps_sla_breached", rep_id: null, previous_assignment_id: second });
    expect(await redistribute(third)).toBeNull();
  });

  it("não redistribui o que já foi assumido, e uma segunda chamada é inócua", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org), past());
    await db.query("select public.accept_assignment($1,$2,false)", [id, marina.userId]);
    expect(await redistribute(id)).toBeNull();
  });

  it("segunda chamada sobre a mesma atribuição vencida não cria duplicata", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org), past());
    expect(await redistribute(id)).not.toBeNull();
    expect(await redistribute(id)).toBeNull();
  });

  it("com o outro vendedor pausado, vai para exceção em vez de ficar parado", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2, "paused");
    const created = await redistribute(await distribute(org, await seedHandoff(db, org), past()));
    expect(await row(created!)).toMatchObject({ status: "exception", exception_reason: "all_reps_sla_breached" });
  });
});

describe("accept_assignment", () => {
  it("o vendedor atribuído assume; outro vendedor não; admin assume em nome dele", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const id = await distribute(org, await seedHandoff(db, org));
    await expect(db.query("select public.accept_assignment($1,$2,false)", [id, marcio.userId])).rejects.toThrow(/Somente o vendedor/);
    const adminId = await uuid(db);
    await db.query("select public.accept_assignment($1,$2,true)", [id, adminId]);
    expect(await row(id)).toMatchObject({ status: "accepted", accepted_via: "admin" });
    expect(marina.userId).toBeTruthy();
  });

  it("aceite do vendedor registra o botão e a hora", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const id = await distribute(org, await seedHandoff(db, org));
    expect((await db.query<any>("select public.accept_assignment($1,$2,false) as ok", [id, marina.userId])).rows[0].ok).toBe(true);
    const a = await row(id); expect(a).toMatchObject({ status: "accepted", accepted_via: "button" }); expect(a.accepted_at).not.toBeNull();
    expect((await db.query<any>("select public.accept_assignment($1,$2,false) as ok", [id, marina.userId])).rows[0].ok).toBe(false); // já assumido
  });
});

describe("record_human_message", () => {
  const record = async (org: string, conv: string, author: string | null, via: string, at = new Date().toISOString()) =>
    (await db.query<{ id: string | null }>("select public.record_human_message($1,$2,$3,$4,$5) as id", [org, conv, at, author, via])).rows[0].id;

  it("primeira mensagem do painel pelo vendedor atribuído assume e marca a primeira resposta", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h);
    expect(await record(org, h.conversationId, marina.userId, "panel")).toBe(id);
    const a = await row(id);
    expect(a).toMatchObject({ status: "accepted", accepted_via: "first_message", first_human_message_by: marina.userId });
    expect(a.first_human_message_at).not.toBeNull();
  });

  it("mensagem de um admin registra a primeira resposta mas NÃO assume o lead", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h); const adminId = await uuid(db);
    await record(org, h.conversationId, adminId, "panel");
    expect(await row(id)).toMatchObject({ status: "pending", accepted_at: null, first_human_message_by: adminId });
  });

  it("eco do celular assume só quando a conversa está atribuída ao vendedor da atribuição", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h);
    await record(org, h.conversationId, null, "phone_echo");
    expect(await row(id)).toMatchObject({ status: "accepted", accepted_via: "phone_echo" });
    expect(marina.userId).toBeTruthy();
  });

  it("eco do celular não assume se a conversa foi atribuída a outra pessoa", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h);
    await db.query("update public.conversations set assigned_to=gen_random_uuid() where id=$1", [h.conversationId]);
    await record(org, h.conversationId, null, "phone_echo");
    expect((await row(id)).status).toBe("pending");
  });

  it("só a primeira mensagem conta; as seguintes não alteram o marco", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const id = await distribute(org, h);
    await record(org, h.conversationId, marina.userId, "panel", "2026-10-07T12:00:00Z");
    await record(org, h.conversationId, marina.userId, "panel", "2026-10-07T13:00:00Z");
    expect((await row(id)).first_human_message_at.toISOString()).toBe("2026-10-07T12:00:00.000Z");
  });

  it("mensagem humana atualiza last_commercial_activity_at do negócio aberto (mantém a carteira)", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    const opp = (await db.query<any>("insert into public.opportunities(organization_id,contact_id) values ($1,$2) returning id", [org, h.contactId])).rows[0].id;
    await distribute(org, h);
    await record(org, h.conversationId, marina.userId, "panel", "2026-10-07T12:00:00Z");
    const o = (await db.query<any>("select last_commercial_activity_at from public.opportunities where id=$1", [opp])).rows[0];
    expect(o.last_commercial_activity_at.toISOString()).toBe("2026-10-07T12:00:00.000Z");
  });

  it("sem atribuição ativa devolve NULL (feature desligada ou conversa antiga)", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    expect(await record(org, h.conversationId, await uuid(db), "panel")).toBeNull();
  });
});

describe("manual_assign", () => {
  it("resolve uma exceção atribuindo a um vendedor, preservando o histórico", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    const exc = await distribute(org, h); // sem vendedores: exceção
    const marina = await seedRep(db, org, "Marina", 1); const adminId = await uuid(db);
    const id = (await db.query<any>("select public.manual_assign($1,$2,$3,$4,$5) as id", [org, h.conversationId, marina.repId, adminId, inMinutes(15)])).rows[0].id;
    expect(await row(id)).toMatchObject({ reason: "manual", status: "pending", display_name: "Marina", previous_assignment_id: exc });
    expect(await row(exc)).toMatchObject({ status: "exception", resolved_by: adminId, resolution: "manual_assignment", next_assignment_id: id });
  });

  it("reatribui um lead ativo: o antigo vira redistributed", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    const h = await seedHandoff(db, org); const first = await distribute(org, h); const adminId = await uuid(db);
    const id = (await db.query<any>("select public.manual_assign($1,$2,$3,$4,$5) as id", [org, h.conversationId, marcio.repId, adminId, inMinutes(15)])).rows[0].id;
    expect(await row(first)).toMatchObject({ status: "redistributed", redistribution_reason: "manual", next_assignment_id: id });
    expect((await db.query<any>("select assigned_to from public.conversations where id=$1", [h.conversationId])).rows[0].assigned_to).toBe(marcio.userId);
    expect(marina.repId).toBeTruthy();
  });

  it("recusa vendedor fora da distribuição e conversa sem histórico", async () => {
    const org = await seedOrg(db); const out = await seedRep(db, org, "Marina", 1, "out");
    const h = await seedHandoff(db, org); await distribute(org, h); const adminId = await uuid(db);
    await expect(db.query("select public.manual_assign($1,$2,$3,$4,$5)", [org, h.conversationId, out.repId, adminId, inMinutes(15)])).rejects.toThrow(/fora/i);
    const lone = await seedHandoff(db, org);
    await expect(db.query("select public.manual_assign($1,$2,$3,$4,$5)", [org, lone.conversationId, out.repId, adminId, inMinutes(15)])).rejects.toThrow(/sem atribui/i);
  });
});

describe("marcar um vendedor como out", () => {
  it("não move nenhum lead (sem redistribuição em massa)", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1); await seedRep(db, org, "Márcio", 2);
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) { ids.push(await distribute(org, await seedHandoff(db, org))); await db.query("update public.lead_distribution_state set last_rotation_order=0 where organization_id=$1", [org]); }
    await db.query("update public.sales_reps set availability='out' where id=$1", [marina.repId]);
    const rows = (await db.query<any>("select status, count(*)::int as n from public.lead_assignments group by status")).rows;
    expect(rows).toEqual([{ status: "pending", n: 3 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/lead-distribution-lifecycle.test.ts`
Expected: FAIL (funções inexistentes).

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261007120200_lead_distribution_lifecycle.sql
CREATE FUNCTION public.redistribute_assignment(p_assignment_id uuid, p_new_sla_due_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; cur public.sales_reps; nxt public.sales_reps; new_id uuid; opp_id uuid; org uuid;
BEGIN
  SELECT organization_id INTO org FROM public.lead_assignments WHERE id = p_assignment_id;
  IF org IS NULL THEN RETURN NULL; END IF;
  -- Mesma ordem de travas de distribute_lead: estado da organização primeiro, depois a linha.
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = org FOR UPDATE;
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF a.status <> 'pending' OR a.sla_due_at IS NULL OR a.sla_due_at > now() THEN RETURN NULL; END IF;

  SELECT * INTO cur FROM public.sales_reps WHERE id = a.rep_id;
  SELECT r.* INTO nxt FROM public.sales_reps r
   WHERE r.organization_id = a.organization_id AND r.availability = 'available'
     AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.lead_assignments x WHERE x.chain_id = a.chain_id AND x.rep_id = r.id)
   ORDER BY (r.rotation_order > cur.rotation_order) DESC, r.rotation_order LIMIT 1;

  UPDATE public.lead_assignments SET status = 'expired', sla_breached = true, redistribution_reason = 'sla_expired' WHERE id = a.id;

  IF nxt.id IS NULL THEN
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at,
                                         previous_assignment_id, exception_reason, origin_source, operation, product_model, strategy_version)
    VALUES (a.organization_id, a.chain_id, a.handoff_event_id, a.contact_id, a.conversation_id, a.opportunity_id, NULL, 'exception', 'exception', a.handoff_at,
            a.id, 'all_reps_sla_breached', a.origin_source, a.operation, a.product_model, a.strategy_version)
    RETURNING id INTO new_id;
  ELSE
    opp_id := public._lead_apply_effects(a.organization_id, a.conversation_id, a.contact_id, nxt.user_id);
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at,
                                         previous_assignment_id, origin_source, operation, product_model, strategy_version)
    VALUES (a.organization_id, a.chain_id, a.handoff_event_id, a.contact_id, a.conversation_id, opp_id, nxt.id, 'sla_redistribution', 'pending', a.handoff_at, p_new_sla_due_at,
            a.id, a.origin_source, a.operation, a.product_model, a.strategy_version)
    RETURNING id INTO new_id;
    -- O ponteiro acompanha quem recebeu: o próximo lead novo vai ao outro vendedor.
    UPDATE public.lead_distribution_state SET last_rotation_order = nxt.rotation_order, updated_at = now() WHERE organization_id = a.organization_id;
    UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = nxt.id;
  END IF;
  UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = a.id;
  RETURN new_id;
END $$;

CREATE FUNCTION public.accept_assignment(p_assignment_id uuid, p_actor uuid, p_actor_is_admin boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; rep public.sales_reps;
BEGIN
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF a.id IS NULL OR a.status <> 'pending' THEN RETURN false; END IF;
  SELECT * INTO rep FROM public.sales_reps WHERE id = a.rep_id;
  IF NOT p_actor_is_admin AND p_actor IS DISTINCT FROM rep.user_id THEN
    RAISE EXCEPTION 'Somente o vendedor atribuído (ou um admin) pode assumir o lead';
  END IF;
  UPDATE public.lead_assignments
     SET status = 'accepted', accepted_at = now(), accepted_via = CASE WHEN p_actor_is_admin AND p_actor IS DISTINCT FROM rep.user_id THEN 'admin' ELSE 'button' END
   WHERE id = a.id;
  RETURN true;
END $$;

-- Primeira mensagem humana: marca a primeira resposta (KPI) e, se vier do vendedor atribuído, assume o lead.
-- O chamador já filtrou a origem humana (isHumanOriginMessage); aqui só se aplica a regra de quem pode assumir.
CREATE FUNCTION public.record_human_message(p_organization_id uuid, p_conversation_id uuid, p_at timestamptz, p_author uuid, p_via text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; rep public.sales_reps; conv_user uuid; may_accept boolean := false;
BEGIN
  IF p_via NOT IN ('panel','phone_echo') THEN RAISE EXCEPTION 'Origem inválida'; END IF;
  SELECT * INTO a FROM public.lead_assignments
   WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id AND status IN ('pending','accepted') FOR UPDATE;
  IF a.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO rep FROM public.sales_reps WHERE id = a.rep_id;
  IF a.first_human_message_at IS NULL THEN
    UPDATE public.lead_assignments SET first_human_message_at = p_at, first_human_message_by = p_author WHERE id = a.id;
  END IF;
  -- Atividade comercial relevante (mensagem humana) mantém a carteira dentro da janela de 30 dias.
  UPDATE public.opportunities SET last_commercial_activity_at = GREATEST(COALESCE(last_commercial_activity_at, p_at), p_at)
   WHERE organization_id = p_organization_id AND contact_id = a.contact_id AND status = 'open';
  IF a.status = 'pending' THEN
    IF p_via = 'panel' THEN may_accept := p_author IS NOT DISTINCT FROM rep.user_id;
    ELSE
      SELECT assigned_to INTO conv_user FROM public.conversations WHERE id = p_conversation_id;
      may_accept := p_author IS NULL AND conv_user IS NOT DISTINCT FROM rep.user_id;
    END IF;
    IF may_accept THEN
      UPDATE public.lead_assignments SET status = 'accepted', accepted_at = p_at, accepted_via = CASE WHEN p_via = 'panel' THEN 'first_message' ELSE 'phone_echo' END WHERE id = a.id;
    END IF;
  END IF;
  RETURN a.id;
END $$;

CREATE FUNCTION public.manual_assign(p_organization_id uuid, p_conversation_id uuid, p_rep_id uuid, p_actor uuid, p_sla_due_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev public.lead_assignments; rep public.sales_reps; new_id uuid; opp_id uuid;
BEGIN
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = p_organization_id FOR UPDATE;
  SELECT * INTO prev FROM public.lead_assignments
   WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id
     AND (status IN ('pending','accepted') OR (status = 'exception' AND resolved_at IS NULL))
   ORDER BY assigned_at DESC LIMIT 1 FOR UPDATE;
  IF prev.id IS NULL THEN RAISE EXCEPTION 'Conversa sem atribuição ou exceção para reatribuir'; END IF;
  SELECT * INTO rep FROM public.sales_reps WHERE id = p_rep_id AND organization_id = p_organization_id;
  IF rep.id IS NULL THEN RAISE EXCEPTION 'Vendedor inexistente'; END IF;
  IF rep.availability = 'out' THEN RAISE EXCEPTION 'Vendedor fora da distribuição'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = p_organization_id AND m.user_id = rep.user_id) THEN
    RAISE EXCEPTION 'Vendedor não é mais membro da organização';
  END IF;

  IF prev.status = 'exception' THEN
    UPDATE public.lead_assignments SET resolved_at = now(), resolved_by = p_actor, resolution = 'manual_assignment' WHERE id = prev.id;
  ELSE
    UPDATE public.lead_assignments SET status = 'redistributed', redistribution_reason = 'manual' WHERE id = prev.id;
  END IF;
  opp_id := public._lead_apply_effects(p_organization_id, p_conversation_id, prev.contact_id, rep.user_id);
  INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at,
                                       previous_assignment_id, origin_source, operation, product_model, strategy_version)
  VALUES (p_organization_id, prev.chain_id, prev.handoff_event_id, prev.contact_id, prev.conversation_id, opp_id, rep.id, 'manual', 'pending', prev.handoff_at, p_sla_due_at,
          prev.id, prev.origin_source, prev.operation, prev.product_model, prev.strategy_version)
  RETURNING id INTO new_id;
  UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = prev.id;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION public.redistribute_assignment(uuid, timestamptz), public.accept_assignment(uuid, uuid, boolean),
  public.record_human_message(uuid, uuid, timestamptz, uuid, text), public.manual_assign(uuid, uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redistribute_assignment(uuid, timestamptz), public.accept_assignment(uuid, uuid, boolean),
  public.record_human_message(uuid, uuid, timestamptz, uuid, text), public.manual_assign(uuid, uuid, uuid, uuid, timestamptz) TO service_role;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql`
Expected: PASS nos três arquivos de SQL. Corrija a função, não o teste, se algo divergir da spec. Em particular confira: a exceção de `manual_assign` com `resolved_at` deve respeitar o gatilho de imutabilidade (`resolved_*` e `next_assignment_id` são mutáveis).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261007120200_lead_distribution_lifecycle.sql packages/database/src/sql/lead-distribution-lifecycle.test.ts
git commit -m "feat(distribution): SLA redistribution, acceptance, human-message milestones and manual assignment"
```

---

### Task 6: Camada de acesso a dados em TypeScript

**Files:**
- Create: `packages/database/src/queries/lead-distribution.ts`
- Create: `packages/database/src/queries/lead-distribution.test.ts`
- Modify: `packages/database/src/queries/index.ts` (adicionar `export * from "./lead-distribution.js";`)

**Interfaces:**
- Consumes: RPCs das Tasks 4/5; `resolveBusinessCalendar`, `addBusinessMinutes`, `DEFAULT_LEAD_SLA_MINUTES` da Task 1/2; `getOrganizationById` (já existe em `./organizations.js`).
- Produces (todas recebem `db: SupabaseClient` primeiro):
  - `computeSlaDueAt(settings: OrganizationSettings, from: Date): Date` (nunca lança: calendário inválido cai no padrão)
  - `distributeLeadForHandoff(db, p: {organizationId: string; conversationId: string; handoffEventId: string; context?: DistributionContext; now?: Date}): Promise<string | null>`
  - `listExpiredAssignments(db, limit?: number): Promise<Array<{id: string; organization_id: string}>>`
  - `redistributeAssignment(db, id: string, newSlaDueAt: Date): Promise<string | null>`
  - `acceptAssignment(db, p: {assignmentId: string; actorUserId: string; actorIsAdmin: boolean}): Promise<boolean>`
  - `recordHumanMessage(db, p: {organizationId: string; conversationId: string; at: Date; authorUserId: string | null; via: "panel" | "phone_echo"}): Promise<string | null>`
  - `manualAssignLead(db, p: {organizationId: string; conversationId: string; repId: string; actorUserId: string; slaDueAt: Date}): Promise<string>`
  - `listSalesReps(db, orgId): Promise<SalesRep[]>`, `getSalesRepByUser(db, orgId, userId): Promise<SalesRep | null>`
  - `setRepAvailability(db, p: {organizationId: string; repId: string; availability: SalesRepAvailability}): Promise<SalesRep>`
  - `listAssignmentsForContact(db, orgId, contactId): Promise<LeadAssignment[]>`
  - `listOpenExceptions(db, orgId): Promise<LeadAssignment[]>`
  - `listActiveAssignments(db, orgId): Promise<LeadAssignment[]>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/database/src/queries/lead-distribution.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  acceptAssignment, computeSlaDueAt, distributeLeadForHandoff, recordHumanMessage, redistributeAssignment,
} from "./lead-distribution.js";

vi.mock("./organizations.js", () => ({ getOrganizationById: vi.fn() }));
import { getOrganizationById } from "./organizations.js";

const rpcDb = (data: unknown = "id-1", error: unknown = null) => {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { db: { rpc } as any, rpc };
};

describe("computeSlaDueAt", () => {
  it("usa 15 minutos úteis por padrão e pula o fim de semana", () => {
    const due = computeSlaDueAt({}, new Date("2026-10-09T20:50:00Z")); // sex 17:50
    expect(due.toISOString()).toBe("2026-10-12T11:05:00.000Z");
  });
  it("respeita lead_sla_minutes e business_calendar configurados", () => {
    const due = computeSlaDueAt({ lead_sla_minutes: 30, business_calendar: { weekly: { sat: [{ start: "08:00", end: "12:00" }] } } as any }, new Date("2026-10-10T14:00:00Z"));
    expect(due.toISOString()).toBe("2026-10-10T14:30:00.000Z"); // sáb 11:00 + 30 → 11:30 (janela de sábado configurada)
  });
  it("calendário inválido nunca derruba: usa o padrão", () => {
    const due = computeSlaDueAt({ business_calendar: { weekly: {} } as any }, new Date("2026-10-05T12:00:00Z"));
    expect(due.toISOString()).toBe("2026-10-05T12:15:00.000Z");
  });
});

describe("distributeLeadForHandoff", () => {
  it("não chama o banco com a flag desligada", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: {} } as any);
    const { db, rpc } = rpcDb();
    expect(await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h" })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("chama distribute_lead com o prazo calculado e o contexto", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_enabled: true } } as any);
    const { db, rpc } = rpcDb("assign-1");
    const id = await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h", now: new Date("2026-10-05T12:00:00Z"), context: { operation: "financing" } });
    expect(id).toBe("assign-1");
    expect(rpc).toHaveBeenCalledWith("distribute_lead", {
      p_organization_id: "o", p_conversation_id: "c", p_handoff_event_id: "h",
      p_sla_due_at: "2026-10-05T12:15:00.000Z", p_context: { operation: "financing" },
    });
  });
  it("propaga o erro do banco para o chamador decidir", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_enabled: true } } as any);
    const { db } = rpcDb(null, { message: "boom" });
    await expect(distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h" })).rejects.toEqual({ message: "boom" });
  });
});

describe("RPC wrappers", () => {
  it("redistributeAssignment envia o novo prazo em ISO", async () => {
    const { db, rpc } = rpcDb("new");
    await redistributeAssignment(db, "a1", new Date("2026-10-05T12:15:00Z"));
    expect(rpc).toHaveBeenCalledWith("redistribute_assignment", { p_assignment_id: "a1", p_new_sla_due_at: "2026-10-05T12:15:00.000Z" });
  });
  it("acceptAssignment e recordHumanMessage mapeiam os parâmetros", async () => {
    const a = rpcDb(true);
    expect(await acceptAssignment(a.db, { assignmentId: "a", actorUserId: "u", actorIsAdmin: false })).toBe(true);
    expect(a.rpc).toHaveBeenCalledWith("accept_assignment", { p_assignment_id: "a", p_actor: "u", p_actor_is_admin: false });
    const b = rpcDb("a");
    await recordHumanMessage(b.db, { organizationId: "o", conversationId: "c", at: new Date("2026-10-05T12:00:00Z"), authorUserId: null, via: "phone_echo" });
    expect(b.rpc).toHaveBeenCalledWith("record_human_message", { p_organization_id: "o", p_conversation_id: "c", p_at: "2026-10-05T12:00:00.000Z", p_author: null, p_via: "phone_echo" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/database exec vitest run src/queries/lead-distribution.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/database/src/queries/lead-distribution.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addBusinessMinutes, DEFAULT_LEAD_SLA_MINUTES, resolveBusinessCalendar,
  type DistributionContext, type LeadAssignment, type OrganizationSettings, type SalesRep, type SalesRepAvailability,
} from "@aula-agente/shared";
import { getOrganizationById } from "./organizations.js";

/** Prazo do SLA em minutos úteis. Nunca lança: calendário inválido cai no padrão. */
export function computeSlaDueAt(settings: Partial<OrganizationSettings>, from: Date): Date {
  const minutes = Number.isFinite(settings.lead_sla_minutes) && (settings.lead_sla_minutes as number) > 0 ? (settings.lead_sla_minutes as number) : DEFAULT_LEAD_SLA_MINUTES;
  const calendar = resolveBusinessCalendar(settings.business_calendar);
  try { return addBusinessMinutes(from, minutes, calendar); } catch { return addBusinessMinutes(from, minutes); }
}

export async function distributeLeadForHandoff(
  db: SupabaseClient,
  p: { organizationId: string; conversationId: string; handoffEventId: string; context?: DistributionContext; now?: Date }
): Promise<string | null> {
  const org = await getOrganizationById(db, p.organizationId);
  if (org.settings.lead_distribution_enabled !== true) return null;
  const due = computeSlaDueAt(org.settings, p.now ?? new Date());
  const { data, error } = await db.rpc("distribute_lead", {
    p_organization_id: p.organizationId, p_conversation_id: p.conversationId, p_handoff_event_id: p.handoffEventId,
    p_sla_due_at: due.toISOString(), p_context: p.context ?? {},
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function listExpiredAssignments(db: SupabaseClient, limit = 50) {
  const { data, error } = await db.from("lead_assignments").select("id, organization_id")
    .eq("status", "pending").lte("sla_due_at", new Date().toISOString()).order("sla_due_at").limit(limit);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; organization_id: string }>;
}

export async function redistributeAssignment(db: SupabaseClient, id: string, newSlaDueAt: Date): Promise<string | null> {
  const { data, error } = await db.rpc("redistribute_assignment", { p_assignment_id: id, p_new_sla_due_at: newSlaDueAt.toISOString() });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function acceptAssignment(db: SupabaseClient, p: { assignmentId: string; actorUserId: string; actorIsAdmin: boolean }): Promise<boolean> {
  const { data, error } = await db.rpc("accept_assignment", { p_assignment_id: p.assignmentId, p_actor: p.actorUserId, p_actor_is_admin: p.actorIsAdmin });
  if (error) throw error;
  return data === true;
}

export async function recordHumanMessage(
  db: SupabaseClient,
  p: { organizationId: string; conversationId: string; at: Date; authorUserId: string | null; via: "panel" | "phone_echo" }
): Promise<string | null> {
  const { data, error } = await db.rpc("record_human_message", {
    p_organization_id: p.organizationId, p_conversation_id: p.conversationId, p_at: p.at.toISOString(), p_author: p.authorUserId, p_via: p.via,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function manualAssignLead(
  db: SupabaseClient,
  p: { organizationId: string; conversationId: string; repId: string; actorUserId: string; slaDueAt: Date }
): Promise<string> {
  const { data, error } = await db.rpc("manual_assign", {
    p_organization_id: p.organizationId, p_conversation_id: p.conversationId, p_rep_id: p.repId, p_actor: p.actorUserId, p_sla_due_at: p.slaDueAt.toISOString(),
  });
  if (error) throw error;
  return data as string;
}

export async function listSalesReps(db: SupabaseClient, organizationId: string): Promise<SalesRep[]> {
  const { data, error } = await db.from("sales_reps").select("*").eq("organization_id", organizationId).order("rotation_order");
  if (error) throw error;
  return (data ?? []) as SalesRep[];
}

export async function getSalesRepByUser(db: SupabaseClient, organizationId: string, userId: string): Promise<SalesRep | null> {
  const { data, error } = await db.from("sales_reps").select("*").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as SalesRep | null) ?? null;
}

export async function setRepAvailability(db: SupabaseClient, p: { organizationId: string; repId: string; availability: SalesRepAvailability }): Promise<SalesRep> {
  const now = new Date().toISOString();
  const { data, error } = await db.from("sales_reps")
    .update({ availability: p.availability, availability_changed_at: now, updated_at: now })
    .eq("organization_id", p.organizationId).eq("id", p.repId).select("*").single();
  if (error) throw error;
  return data as SalesRep;
}

export async function listAssignmentsForContact(db: SupabaseClient, organizationId: string, contactId: string): Promise<LeadAssignment[]> {
  const { data, error } = await db.from("lead_assignments").select("*").eq("organization_id", organizationId).eq("contact_id", contactId).order("assigned_at");
  if (error) throw error;
  return (data ?? []) as LeadAssignment[];
}

export async function listOpenExceptions(db: SupabaseClient, organizationId: string): Promise<LeadAssignment[]> {
  const { data, error } = await db.from("lead_assignments").select("*").eq("organization_id", organizationId).eq("status", "exception").is("resolved_at", null).order("assigned_at");
  if (error) throw error;
  return (data ?? []) as LeadAssignment[];
}

export async function listActiveAssignments(db: SupabaseClient, organizationId: string): Promise<LeadAssignment[]> {
  const { data, error } = await db.from("lead_assignments").select("*").eq("organization_id", organizationId).in("status", ["pending", "accepted"]);
  if (error) throw error;
  return (data ?? []) as LeadAssignment[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/database exec vitest run src/queries/lead-distribution.test.ts && pnpm --filter @aula-agente/database exec tsc --noEmit`
Expected: PASS e sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
echo 'export * from "./lead-distribution.js";' >> packages/database/src/queries/index.ts
pnpm --filter @aula-agente/database build
git add packages/database/src
git commit -m "feat(distribution): database access layer and SLA due-date computation"
```

---

### Task 7: Chamar a distribuição no handoff (`requestHuman`)

**Files:**
- Create: `packages/agent-runtime/src/handoff-distribution.ts`
- Create: `packages/agent-runtime/src/handoff-distribution.test.ts`
- Modify: `packages/agent-runtime/src/tools/request-human.ts` (por volta das linhas 139-152)

**Interfaces:**
- Consumes: `distributeLeadForHandoff` (Task 6); `createHandoffEvent` já devolve a linha (`HandoffEvent` com `id`).
- Produces: `safeDistribute(distribute, db, input): Promise<string | null>` (nunca lança).

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-runtime/src/handoff-distribution.test.ts
import { describe, expect, it, vi } from "vitest";
import { safeDistribute } from "./handoff-distribution.js";

const input = { organizationId: "o", conversationId: "c", handoffEventId: "h" };

describe("safeDistribute", () => {
  it("devolve o id da atribuição", async () => {
    const distribute = vi.fn().mockResolvedValue("assign-1");
    expect(await safeDistribute(distribute, {} as any, input)).toBe("assign-1");
    expect(distribute).toHaveBeenCalledWith({}, input);
  });
  it("nunca derruba o handoff: erro do banco vira null e é registrado", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const distribute = vi.fn().mockRejectedValue(new Error("db down"));
    expect(await safeDistribute(distribute, {} as any, input)).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
  it("com zero vendedores a função do banco devolve a exceção e nada quebra", async () => {
    const distribute = vi.fn().mockResolvedValue("exception-row");
    expect(await safeDistribute(distribute, {} as any, input)).toBe("exception-row");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/agent-runtime exec vitest run src/handoff-distribution.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Write minimal implementation and wire it**

```ts
// packages/agent-runtime/src/handoff-distribution.ts
import type { SupabaseClient } from "@supabase/supabase-js";

type DistributeInput = { organizationId: string; conversationId: string; handoffEventId: string };
type Distribute = (db: SupabaseClient, input: DistributeInput) => Promise<string | null>;

/** A distribuição é best-effort: o handoff da Mariana nunca falha por causa dela. */
export async function safeDistribute(distribute: Distribute, db: SupabaseClient, input: DistributeInput): Promise<string | null> {
  try {
    return await distribute(db, input);
  } catch (err) {
    console.error("requestHuman: lead distribution failed (handoff preserved):", err);
    return null;
  }
}
```

Em `packages/agent-runtime/src/tools/request-human.ts`:

1. No bloco de imports de `@aula-agente/database`, adicione `distributeLeadForHandoff` e, no topo do arquivo, `import { safeDistribute } from "../handoff-distribution.js";`.
2. Troque o `await createHandoffEvent(db, {...});` (hoje sem usar o retorno) para guardar o evento e, **depois** do bloco `try { await reassignOpenTasksToHuman(...) } catch {...}`, chame a distribuição:

```ts
        const handoffEvent = await createHandoffEvent(db, {
          organization_id: context.organizationId,
          conversation_id: context.conversationId,
          trigger_type: "request_human",
          motivo,
          resumo,
          urgencia,
          criado_por: "ia",
        });

        try {
          await reassignOpenTasksToHuman(/* ...argumentos existentes, sem alteração... */);
        } catch (err) {
          console.error("requestHuman tool: failed to reassign open tasks:", err);
        }

        // Rodízio (flag lead_distribution_enabled): define o responsável depois do handoff e das tarefas,
        // sobrescrevendo o responsável padrão quando a distribuição está ligada.
        await safeDistribute(distributeLeadForHandoff, db, {
          organizationId: context.organizationId,
          conversationId: context.conversationId,
          handoffEventId: handoffEvent.id,
        });
```

Não altere o restante da função (aviso por telefone, tarefa de fallback, resposta ao modelo).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/agent-runtime exec vitest run && pnpm --filter @aula-agente/agent-runtime exec tsc --noEmit`
Expected: PASS em toda a suíte (os testes existentes de `request-human` continuam passando; se algum mockar `createHandoffEvent` sem devolver `id`, ajuste o mock para devolver `{ id: "h1" }`).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src
git commit -m "feat(distribution): distribute lead after requestHuman handoff, never failing it"
```

---

### Task 8: Worker da varredura de SLA (a cada 60 s)

**Files:**
- Modify: `packages/shared/src/constants.ts` (adicionar `LEAD_SLA: "lead-sla"` em `QUEUE_NAMES`)
- Modify: `packages/queue/src/queues.ts` (getter `getLeadSlaQueue`)
- Create: `apps/worker/src/workers/lead-sla.ts`
- Create: `apps/worker/src/workers/lead-sla.test.ts`
- Modify: `apps/worker/src/index.ts` (registrar o worker)

**Interfaces:**
- Consumes: `listExpiredAssignments`, `redistributeAssignment`, `computeSlaDueAt` (Task 6); `getOrganizationById`.
- Produces: `runLeadSlaSweep(db, now?: Date): Promise<{checked: number; redistributed: number; exceptions: number}>`; `startLeadSlaWorker()`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/src/workers/lead-sla.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  listExpiredAssignments: vi.fn(), redistributeAssignment: vi.fn(), getOrganizationById: vi.fn(),
  computeSlaDueAt: vi.fn((_s: unknown, from: Date) => new Date(from.getTime() + 15 * 60_000)),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getLeadSlaQueue: () => ({ upsertJobScheduler: vi.fn() }) }));
import { runLeadSlaSweep } from "./lead-sla.js";

const now = new Date("2026-10-05T12:00:00Z");
beforeEach(() => {
  vi.clearAllMocks();
  m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } });
  m.redistributeAssignment.mockResolvedValue("new-id");
});

describe("runLeadSlaSweep", () => {
  it("não faz nada quando não há atribuições vencidas", async () => {
    m.listExpiredAssignments.mockResolvedValue([]);
    expect(await runLeadSlaSweep({} as any, now)).toEqual({ checked: 0, redistributed: 0, exceptions: 0 });
    expect(m.redistributeAssignment).not.toHaveBeenCalled();
  });

  it("redistribui cada vencida com um novo prazo calculado a partir de agora", async () => {
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }, { id: "a2", organization_id: "o" }]);
    const result = await runLeadSlaSweep({} as any, now);
    expect(result).toMatchObject({ checked: 2, redistributed: 2 });
    expect(m.redistributeAssignment).toHaveBeenCalledWith({}, "a1", new Date("2026-10-05T12:15:00Z"));
    expect(m.getOrganizationById).toHaveBeenCalledTimes(1); // cache por organização no mesmo ciclo
  });

  it("ignora organização com a flag desligada", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: {} });
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }]);
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ checked: 1, redistributed: 0 });
    expect(m.redistributeAssignment).not.toHaveBeenCalled();
  });

  it("não conta duas vezes quando outro worker já redistribuiu (retorno null)", async () => {
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }]);
    m.redistributeAssignment.mockResolvedValue(null);
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ redistributed: 0 });
  });

  it("um erro em uma atribuição não impede as seguintes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }, { id: "a2", organization_id: "o" }]);
    m.redistributeAssignment.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce("new");
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ checked: 2, redistributed: 1 });
    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/worker exec vitest run src/workers/lead-sla.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Write minimal implementation**

Em `packages/shared/src/constants.ts`, dentro de `QUEUE_NAMES`, adicione `LEAD_SLA: "lead-sla",`.

Em `packages/queue/src/queues.ts`, no mesmo estilo de `getTakeoverTimeoutQueue`:

```ts
let leadSlaQueue: Queue<{}> | undefined;
export function getLeadSlaQueue() {
  if (!leadSlaQueue) leadSlaQueue = new Queue<{}>(QUEUE_NAMES.LEAD_SLA, { connection: getRedisConnection() });
  return leadSlaQueue;
}
```

```ts
// apps/worker/src/workers/lead-sla.ts
import { Worker } from "bullmq";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QUEUE_NAMES, type OrganizationSettings } from "@aula-agente/shared";
import { getLeadSlaQueue, getRedisConnection } from "@aula-agente/queue";
import { computeSlaDueAt, getAdminClient, getOrganizationById, listExpiredAssignments, redistributeAssignment } from "@aula-agente/database";

const SWEEP_EVERY_MS = 60_000;

/**
 * Redistribui atribuições com SLA vencido. O banco é a autoridade: redistribute_assignment trava a linha e só age
 * se ela ainda estiver pendente e vencida, então dois workers (ou um reinício) nunca duplicam a redistribuição.
 */
export async function runLeadSlaSweep(db: SupabaseClient, now = new Date()) {
  const expired = await listExpiredAssignments(db);
  const settingsByOrg = new Map<string, Partial<OrganizationSettings>>();
  let redistributed = 0;
  for (const item of expired) {
    try {
      if (!settingsByOrg.has(item.organization_id)) settingsByOrg.set(item.organization_id, (await getOrganizationById(db, item.organization_id)).settings);
      const settings = settingsByOrg.get(item.organization_id)!;
      if (settings.lead_distribution_enabled !== true) continue;
      const created = await redistributeAssignment(db, item.id, computeSlaDueAt(settings, now));
      if (created) redistributed++;
    } catch (err) {
      console.error("Lead SLA sweep: redistribution failed", item.id, err);
    }
  }
  return { checked: expired.length, redistributed, exceptions: 0 };
}

export function startLeadSlaWorker() {
  const worker = new Worker(QUEUE_NAMES.LEAD_SLA, async () => {
    const result = await runLeadSlaSweep(getAdminClient());
    if (result.redistributed) console.log(`Lead SLA: ${result.redistributed} lead(s) redistribuído(s)`);
  }, { connection: getRedisConnection(), concurrency: 1 });
  getLeadSlaQueue().upsertJobScheduler("lead-sla-scheduler", { every: SWEEP_EVERY_MS }, { name: "sweep-lead-sla" });
  worker.on("failed", (job, err) => console.error(`Lead SLA job ${job?.id} failed:`, err.message));
  console.log("Lead-sla worker started (runs every 60 s)");
  return worker;
}
```

Em `apps/worker/src/index.ts`: `import { startLeadSlaWorker } from "./workers/lead-sla.js";` e adicione `startLeadSlaWorker(),` à lista `workers`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/shared build && pnpm --filter @aula-agente/queue build && pnpm --filter @aula-agente/worker exec vitest run && pnpm --filter @aula-agente/worker exec tsc --noEmit`
Expected: PASS (inclui os testes existentes do worker).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/queue/src apps/worker/src
git commit -m "feat(distribution): 60-second lead SLA sweep worker"
```

---

### Task 9: Primeira mensagem humana assume o lead (painel e eco do celular)

**Files:**
- Create: `apps/api/src/services/lead-human-message.ts`
- Create: `apps/api/src/services/lead-human-message.test.ts`
- Modify: `apps/api/src/services/message-send.service.ts` (função `sendPanelMessage`)
- Modify: `apps/api/src/routes/webhooks/evolution.ts` (ramo `fromMe`, depois de `skipTakeover` ser calculado)

**Interfaces:**
- Consumes: `isHumanOriginMessage` (Task 2), `recordHumanMessage` (Task 6).
- Produces: `trackFirstHumanMessage(db, input: {organizationId: string; conversationId: string; role: string; source: "panel" | "phone_echo"; actorUserId?: string | null; metadata?: Record<string, unknown> | null; greetingFiltered?: boolean; at?: Date}): Promise<string | null>` (aplica 6.1.1 e **nunca lança**).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/lead-human-message.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ recordHumanMessage: vi.fn() }));
vi.mock("@aula-agente/database", () => m);
import { trackFirstHumanMessage } from "./lead-human-message.js";

const base = { organizationId: "o", conversationId: "c" };
const at = new Date("2026-10-05T12:00:00Z");
beforeEach(() => { vi.clearAllMocks(); m.recordHumanMessage.mockResolvedValue("a1"); });

describe("trackFirstHumanMessage (regra 6.1.1)", () => {
  it("mensagem do painel pelo vendedor registra com o autor", async () => {
    await trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "panel", actorUserId: "u1", metadata: null, at });
    expect(m.recordHumanMessage).toHaveBeenCalledWith({}, { organizationId: "o", conversationId: "c", at, authorUserId: "u1", via: "panel" });
  });
  it("eco legítimo do celular registra sem autor", async () => {
    await trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "phone_echo", metadata: null, at });
    expect(m.recordHumanMessage).toHaveBeenCalledWith({}, { organizationId: "o", conversationId: "c", at, authorUserId: null, via: "phone_echo" });
  });
  it.each([
    ["resposta da Mariana", { role: "agent", source: "panel" as const, actorUserId: "u1" }],
    ["follow-up automático (cadência)", { role: "human_agent", source: "panel" as const, actorUserId: "u1", metadata: { low_intent_followup: { stage: 1 } } }],
    ["despedida agendada", { role: "human_agent", source: "panel" as const, actorUserId: "u1", metadata: { scheduled_ad_closure: { batch_id: "b" } } }],
    ["mídia/template automático marcado", { role: "human_agent", source: "panel" as const, actorUserId: "u1", metadata: { system_generated: true } }],
    ["painel sem usuário autenticado", { role: "human_agent", source: "panel" as const, actorUserId: null }],
    ["eco de mensagem do próprio sistema", { role: "human_agent", source: "phone_echo" as const, echoMatchedSystemMessage: true }],
    ["saudação curta filtrada", { role: "human_agent", source: "phone_echo" as const, greetingFiltered: true }],
  ])("não registra: %s", async (_name, input) => {
    expect(await trackFirstHumanMessage({} as any, { ...base, metadata: null, ...input } as any)).toBeNull();
    expect(m.recordHumanMessage).not.toHaveBeenCalled();
  });
  it("nunca lança: falha do banco não bloqueia o envio da mensagem", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.recordHumanMessage.mockRejectedValue(new Error("db"));
    expect(await trackFirstHumanMessage({} as any, { ...base, role: "human_agent", source: "panel", actorUserId: "u1", metadata: null })).toBeNull();
    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aula-agente/api exec vitest run src/services/lead-human-message.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Write minimal implementation and wire it**

```ts
// apps/api/src/services/lead-human-message.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { isHumanOriginMessage } from "@aula-agente/shared";
import { recordHumanMessage } from "@aula-agente/database";

interface Input {
  organizationId: string;
  conversationId: string;
  role: string;
  source: "panel" | "phone_echo";
  actorUserId?: string | null;
  metadata?: Record<string, unknown> | null;
  echoMatchedSystemMessage?: boolean;
  greetingFiltered?: boolean;
  at?: Date;
}

/** Marca a primeira resposta humana (e assume o lead quando cabe). Só origem humana comprovada conta. Nunca lança. */
export async function trackFirstHumanMessage(db: SupabaseClient, input: Input): Promise<string | null> {
  if (!isHumanOriginMessage(input)) return null;
  try {
    return await recordHumanMessage(db, {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      at: input.at ?? new Date(),
      authorUserId: input.source === "panel" ? input.actorUserId ?? null : null,
      via: input.source,
    });
  } catch (err) {
    console.error("Failed to record first human message for lead distribution:", err);
    return null;
  }
}
```

Em `apps/api/src/services/message-send.service.ts`, importe `trackFirstHumanMessage` de `./lead-human-message.js` e, **logo depois** do bloco "Closes an existing requestHuman handoff loop's ..." (o `try { const openHandoff = ... markFirstHumanReply ... }`), adicione:

```ts
  // Rodízio: a primeira mensagem humana do vendedor atribuído assume o lead e marca a primeira resposta.
  await trackFirstHumanMessage(db, {
    organizationId: conversation.organization_id,
    conversationId: conversation.id,
    role: message.role,
    source: "panel",
    actorUserId,
    metadata: metadata ?? null,
  });
```

Em `apps/api/src/routes/webhooks/evolution.ts`, no ramo `fromMe`, **depois** da linha `const skipTakeover = shouldSkipTakeoverForGreeting(...)`, adicione (o eco de mensagem do próprio sistema já retornou como `duplicate` mais acima, pelo `evolution_message_id`; por isso `echoMatchedSystemMessage` aqui é `false`):

```ts
        await trackFirstHumanMessage(db, {
          organizationId,
          conversationId: conversation.id,
          role: "human_agent",
          source: "phone_echo",
          metadata: null,
          greetingFiltered: skipTakeover,
        });
```

(importe `trackFirstHumanMessage` de `../../services/lead-human-message.js`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aula-agente/api exec vitest run && pnpm --filter @aula-agente/api exec tsc --noEmit`
Expected: PASS na suíte inteira da API. Os testes existentes de `message-send.service` mockam o banco; se algum falhar por causa da nova chamada, mocke `./lead-human-message.js` com `vi.mock` retornando `trackFirstHumanMessage: vi.fn()`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(distribution): first human message accepts the lead (panel and phone echo, human-origin only)"
```

---

### Task 10: API (visibilidade, aceite, vendedores, exceções, histórico)

**Files:**
- Create: `apps/api/src/lib/lead-visibility.ts` e `lead-visibility.test.ts`
- Create: `apps/api/src/routes/lead-distribution/index.ts` e `lead-distribution.test.ts`
- Modify: `apps/api/src/server.ts` (registrar as rotas)
- Modify: `apps/api/src/services/sales-workspace.service.ts` (anexar a atribuição ao card; ocultar leads de outro vendedor)
- Modify: `apps/api/src/routes/opportunities/index.ts`, `apps/api/src/routes/dashboard/index.ts` (aplicar visibilidade)

**Interfaces:**
- Consumes: funções da Task 6; `request.user`, `request.userRole` do `authMiddleware`.
- Produces:
  - `type LeadVisibility = { mode: "all" } | { mode: "own"; userId: string }`
  - `resolveLeadVisibility(args: {role: string; userId: string; leadDistributionEnabled: boolean}): LeadVisibility` (gestor ou flag desligada → `all`)
  - `isLeadVisible(visibility: LeadVisibility, ownerUserId: string | null | undefined, repUserIds: Set<string>): boolean` (esconde só o que pertence a **outro vendedor**)
  - Rotas (todas exigem `authMiddleware` e checagem de membro da organização):
    - `GET /organizations/:organizationId/sales-reps` → `SalesRep[]` (todos os membros leem a lista, para exibir nomes)
    - `PATCH /organizations/:organizationId/sales-reps/:repId/availability` body `{availability}`; o vendedor muda só o próprio; gestor muda qualquer um
    - `POST /lead-assignments/:id/accept` → `{ accepted: boolean }`
    - `GET /organizations/:organizationId/lead-assignments/exceptions` (gestor) → `LeadAssignment[]`
    - `POST /organizations/:organizationId/lead-assignments/manual` (gestor) body `{conversationId, repId}` → `{ assignmentId }`
    - `GET /organizations/:organizationId/contacts/:contactId/lead-assignments` → histórico (respeita visibilidade)
  - `enrichSalesWorkspace(...)` ganha o 5º parâmetro opcional `leadDistribution?: { enabled: boolean; viewer: LeadVisibility }`; cada card recebe `lead_assignment: { id, rep_id, rep_name, status, sla_due_at, assigned_at, accepted_at } | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/lib/lead-visibility.test.ts
import { describe, expect, it } from "vitest";
import { isLeadVisible, resolveLeadVisibility } from "./lead-visibility.js";

describe("resolveLeadVisibility", () => {
  it("gestor (owner/admin) vê tudo", () => {
    for (const role of ["owner", "admin"]) expect(resolveLeadVisibility({ role, userId: "u", leadDistributionEnabled: true })).toEqual({ mode: "all" });
  });
  it("com a flag desligada ninguém é restringido (comportamento atual)", () => {
    expect(resolveLeadVisibility({ role: "agent", userId: "u", leadDistributionEnabled: false })).toEqual({ mode: "all" });
  });
  it("vendedor com a flag ligada vê os próprios", () => {
    expect(resolveLeadVisibility({ role: "agent", userId: "u", leadDistributionEnabled: true })).toEqual({ mode: "own", userId: "u" });
  });
});

describe("isLeadVisible", () => {
  const reps = new Set(["marina", "marcio"]);
  it("modo all vê tudo", () => { expect(isLeadVisible({ mode: "all" }, "marcio", reps)).toBe(true); });
  it("vendedor vê os próprios", () => { expect(isLeadVisible({ mode: "own", userId: "marina" }, "marina", reps)).toBe(true); });
  it("vendedor NÃO vê o lead de outro vendedor", () => { expect(isLeadVisible({ mode: "own", userId: "marina" }, "marcio", reps)).toBe(false); });
  it("legado sem dono ou com dono que não é vendedor continua visível (decisão de planejamento 1)", () => {
    expect(isLeadVisible({ mode: "own", userId: "marina" }, null, reps)).toBe(true);
    expect(isLeadVisible({ mode: "own", userId: "marina" }, "conta-compartilhada", reps)).toBe(true);
  });
});
```

```ts
// apps/api/src/routes/lead-distribution/lead-distribution.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})), getOrganizationById: vi.fn(), getSalesRepByUser: vi.fn(), listSalesReps: vi.fn(),
  setRepAvailability: vi.fn(), acceptAssignment: vi.fn(), listOpenExceptions: vi.fn(), manualAssignLead: vi.fn(),
  listAssignmentsForContact: vi.fn(), computeSlaDueAt: vi.fn(() => new Date("2026-10-05T12:15:00Z")),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async () => {} }));
import Fastify from "fastify";
import routes from "./index.js";

async function app(role: string, userId = "u1") {
  const f = Fastify();
  f.addHook("preHandler", async (req: any) => { req.user = { id: userId, email: "x", memberships: [{ organization_id: "org", role }] }; req.userRole = role; });
  await f.register(routes);
  return f;
}
beforeEach(() => { vi.clearAllMocks(); m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } }); });

describe("PATCH availability", () => {
  it("vendedor muda o próprio estado", async () => {
    m.getSalesRepByUser.mockResolvedValue({ id: "rep1", user_id: "u1" });
    m.setRepAvailability.mockResolvedValue({ id: "rep1", availability: "paused" });
    const res = await (await app("agent")).inject({ method: "PATCH", url: "/organizations/org/sales-reps/rep1/availability", payload: { availability: "paused" } });
    expect(res.statusCode).toBe(200);
    expect(m.setRepAvailability).toHaveBeenCalledWith(expect.anything(), { organizationId: "org", repId: "rep1", availability: "paused" });
  });
  it("vendedor não muda o estado de outro; gestor muda", async () => {
    m.getSalesRepByUser.mockResolvedValue({ id: "repX", user_id: "u1" });
    expect((await (await app("agent")).inject({ method: "PATCH", url: "/organizations/org/sales-reps/rep1/availability", payload: { availability: "out" } })).statusCode).toBe(403);
    m.setRepAvailability.mockResolvedValue({ id: "rep1" });
    expect((await (await app("admin")).inject({ method: "PATCH", url: "/organizations/org/sales-reps/rep1/availability", payload: { availability: "out" } })).statusCode).toBe(200);
  });
  it("recusa valor inválido", async () => {
    const res = await (await app("admin")).inject({ method: "PATCH", url: "/organizations/org/sales-reps/rep1/availability", payload: { availability: "ferias" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("accept", () => {
  it("passa o ator e se é gestor", async () => {
    m.acceptAssignment.mockResolvedValue(true);
    const res = await (await app("agent")).inject({ method: "POST", url: "/lead-assignments/11111111-1111-4111-8111-111111111111/accept?organizationId=org" });
    expect(res.json()).toEqual({ accepted: true });
    expect(m.acceptAssignment).toHaveBeenCalledWith(expect.anything(), { assignmentId: "11111111-1111-4111-8111-111111111111", actorUserId: "u1", actorIsAdmin: false });
  });
  it("devolve 403 quando o banco recusa o ator", async () => {
    m.acceptAssignment.mockRejectedValue({ message: "Somente o vendedor atribuído (ou um admin) pode assumir o lead" });
    const res = await (await app("agent")).inject({ method: "POST", url: "/lead-assignments/11111111-1111-4111-8111-111111111111/accept?organizationId=org" });
    expect(res.statusCode).toBe(403);
  });
});

describe("fila de exceções e reatribuição manual (gestor)", () => {
  it("vendedor não acessa", async () => {
    expect((await (await app("agent")).inject({ method: "GET", url: "/organizations/org/lead-assignments/exceptions" })).statusCode).toBe(403);
    expect((await (await app("agent")).inject({ method: "POST", url: "/organizations/org/lead-assignments/manual", payload: { conversationId: "11111111-1111-4111-8111-111111111111", repId: "22222222-2222-4222-8222-222222222222" } })).statusCode).toBe(403);
  });
  it("gestor lista e reatribui com novo prazo", async () => {
    m.listOpenExceptions.mockResolvedValue([{ id: "e1" }]);
    expect((await (await app("admin")).inject({ method: "GET", url: "/organizations/org/lead-assignments/exceptions" })).json()).toEqual([{ id: "e1" }]);
    m.manualAssignLead.mockResolvedValue("a9");
    const res = await (await app("owner")).inject({ method: "POST", url: "/organizations/org/lead-assignments/manual", payload: { conversationId: "11111111-1111-4111-8111-111111111111", repId: "22222222-2222-4222-8222-222222222222" } });
    expect(res.json()).toEqual({ assignmentId: "a9" });
    expect(m.manualAssignLead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: "org", actorUserId: "u1", slaDueAt: new Date("2026-10-05T12:15:00Z") }));
  });
});
```

Acrescente ao `sales-workspace.service.test.ts` existente:

```ts
describe("lead distribution on cards", () => {
  it("anexa a atribuição ativa e esconde o lead que pertence a outro vendedor", async () => {
    const { db } = database({
      conversations: [], handoff_events: [], tasks: [],
      opportunities: [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01", owner_id: "marcio-user" }],
      sales_reps: [{ id: "r1", user_id: "marina-user", display_name: "Marina" }, { id: "r2", user_id: "marcio-user", display_name: "Márcio" }],
      lead_assignments: [{ id: "x", contact_id: "c", rep_id: "r2", status: "pending", sla_due_at: "2026-10-05T12:15:00Z", assigned_at: "2026-10-05T12:00:00Z", accepted_at: null }],
    });
    const rows = [{ id: "a", contact_id: "c", status: "open", created_at: "2026-10-01", owner_id: "marcio-user" }];
    const asManager = await enrichSalesWorkspace(db as any, "org", rows as any, true, { enabled: true, viewer: { mode: "all" } });
    expect(asManager[0]).toMatchObject({ lead_assignment: { id: "x", rep_name: "Márcio", status: "pending" } });
    const asMarina = await enrichSalesWorkspace(db as any, "org", rows as any, true, { enabled: true, viewer: { mode: "own", userId: "marina-user" } });
    expect(asMarina).toEqual([]);
    const off = await enrichSalesWorkspace(db as any, "org", rows as any, true);
    expect(off).toHaveLength(1); // sem o parâmetro (flag desligada) nada muda
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @aula-agente/api exec vitest run src/lib/lead-visibility.test.ts src/routes/lead-distribution src/services/sales-workspace.service.test.ts`
Expected: FAIL (módulos e parâmetro novos inexistentes).

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/lib/lead-visibility.ts
export type LeadVisibility = { mode: "all" } | { mode: "own"; userId: string };

const MANAGER_ROLES = ["owner", "admin"];
export const isManager = (role: string) => MANAGER_ROLES.includes(role);

export function resolveLeadVisibility(args: { role: string; userId: string; leadDistributionEnabled: boolean }): LeadVisibility {
  if (!args.leadDistributionEnabled || isManager(args.role)) return { mode: "all" };
  return { mode: "own", userId: args.userId };
}

/**
 * Fase 1 (isolamento de aplicação, não do banco): o vendedor deixa de ver apenas o que pertence a OUTRO vendedor.
 * Leads sem dono, ou com dono legado que não é vendedor, seguem visíveis para não perder a carteira atual na ativação.
 */
export function isLeadVisible(visibility: LeadVisibility, ownerUserId: string | null | undefined, repUserIds: Set<string>): boolean {
  if (visibility.mode === "all") return true;
  if (!ownerUserId || ownerUserId === visibility.userId) return true;
  return !repUserIds.has(ownerUserId);
}
```

```ts
// apps/api/src/routes/lead-distribution/index.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SALES_REP_AVAILABILITIES } from "@aula-agente/shared";
import {
  acceptAssignment, computeSlaDueAt, getAdminClient, getOrganizationById, getSalesRepByUser, listAssignmentsForContact,
  listOpenExceptions, listSalesReps, manualAssignLead, setRepAvailability,
} from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { isManager, resolveLeadVisibility } from "../../lib/lead-visibility.js";

const uuid = z.string().uuid();

export default async function leadDistributionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  const roleIn = (request: any, organizationId: string): string | null =>
    request.user.memberships.find((m: any) => m.organization_id === organizationId)?.role ?? null;

  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/sales-reps", async (request, reply) => {
    if (!roleIn(request, request.params.organizationId)) return reply.status(403).send({ error: "Access denied" });
    return listSalesReps(getAdminClient(), request.params.organizationId);
  });

  app.patch<{ Params: { organizationId: string; repId: string } }>("/organizations/:organizationId/sales-reps/:repId/availability", async (request, reply) => {
    const { organizationId, repId } = request.params;
    const role = roleIn(request, organizationId);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    const body = z.object({ availability: z.enum(SALES_REP_AVAILABILITIES) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues });
    const db = getAdminClient();
    if (!isManager(role)) {
      const own = await getSalesRepByUser(db, organizationId, request.user.id);
      if (!own || own.id !== repId) return reply.status(403).send({ error: "Você só pode alterar a sua própria disponibilidade" });
    }
    return setRepAvailability(db, { organizationId, repId, availability: body.data.availability });
  });

  app.post<{ Params: { id: string }; Querystring: { organizationId?: string } }>("/lead-assignments/:id/accept", async (request, reply) => {
    if (!uuid.safeParse(request.params.id).success) return reply.status(400).send({ error: "id inválido" });
    const organizationId = request.query.organizationId ?? "";
    const role = roleIn(request, organizationId);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    try {
      const accepted = await acceptAssignment(getAdminClient(), { assignmentId: request.params.id, actorUserId: request.user.id, actorIsAdmin: isManager(role) });
      return { accepted };
    } catch (err) {
      const message = (err as { message?: string }).message ?? "Erro ao assumir o lead";
      return reply.status(/Somente o vendedor/.test(message) ? 403 : 500).send({ error: message });
    }
  });

  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/lead-assignments/exceptions", async (request, reply) => {
    const role = roleIn(request, request.params.organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores veem a fila de exceções" });
    return listOpenExceptions(getAdminClient(), request.params.organizationId);
  });

  app.post<{ Params: { organizationId: string } }>("/organizations/:organizationId/lead-assignments/manual", async (request, reply) => {
    const { organizationId } = request.params;
    const role = roleIn(request, organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores reatribuem leads" });
    const body = z.object({ conversationId: uuid, repId: uuid }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues });
    const db = getAdminClient();
    const org = await getOrganizationById(db, organizationId);
    try {
      const assignmentId = await manualAssignLead(db, { organizationId, conversationId: body.data.conversationId, repId: body.data.repId, actorUserId: request.user.id, slaDueAt: computeSlaDueAt(org.settings, new Date()) });
      return { assignmentId };
    } catch (err) {
      return reply.status(400).send({ error: (err as { message?: string }).message ?? "Não foi possível reatribuir" });
    }
  });

  app.get<{ Params: { organizationId: string; contactId: string } }>("/organizations/:organizationId/contacts/:contactId/lead-assignments", async (request, reply) => {
    const { organizationId, contactId } = request.params;
    const role = roleIn(request, organizationId);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    const db = getAdminClient();
    const org = await getOrganizationById(db, organizationId);
    const history = await listAssignmentsForContact(db, organizationId, contactId);
    const visibility = resolveLeadVisibility({ role, userId: request.user.id, leadDistributionEnabled: org.settings.lead_distribution_enabled === true });
    if (visibility.mode === "own") {
      const reps = await listSalesReps(db, organizationId);
      const mine = reps.find(r => r.user_id === visibility.userId);
      const otherRepIds = new Set(reps.filter(r => r.id !== mine?.id).map(r => r.id));
      // Esconde o histórico só quando o lead pertence a outro vendedor e nunca passou pelo próprio.
      const last = history[history.length - 1];
      if (last?.rep_id && otherRepIds.has(last.rep_id) && !history.some(h => h.rep_id === mine?.id)) return [];
    }
    return history;
  });
}
```

Em `apps/api/src/server.ts`, importe `leadDistributionRoutes from "./routes/lead-distribution/index.js"` e registre com `server.register(leadDistributionRoutes);` junto das demais.

Em `apps/api/src/services/sales-workspace.service.ts`, mude a assinatura de `enrichSalesWorkspace` para

```ts
export async function enrichSalesWorkspace<T extends Opportunity>(
  db: ReturnType<typeof getAdminClient>, organizationId: string, rows: T[], enabled: boolean,
  leadDistribution?: { enabled: boolean; viewer: import("../lib/lead-visibility.js").LeadVisibility }
)
```

e, **no final**, antes de devolver o resultado (`return rows.map(...)`), guarde o resultado em `const enriched = rows.map(...)` e aplique:

```ts
  if (!leadDistribution?.enabled) return enriched;
  const [reps, active] = await Promise.all([
    readAll(() => db.from("sales_reps").select("id,user_id,display_name").eq("organization_id", organizationId).order("id")),
    readAll(() => db.from("lead_assignments").select("id,contact_id,rep_id,status,sla_due_at,assigned_at,accepted_at").eq("organization_id", organizationId).in("status", ["pending", "accepted"]).order("id")),
  ]);
  const repNames = new Map(reps.map((r: any) => [r.id, r.display_name]));
  const repUsers = new Set<string>(reps.map((r: any) => r.user_id));
  const byContact = new Map(active.map((a: any) => [a.contact_id, a]));
  return enriched
    .filter((o: any) => isLeadVisible(leadDistribution.viewer, o.owner_id, repUsers))
    .map((o: any) => {
      const a: any = byContact.get(o.contact_id);
      return { ...o, lead_assignment: a ? { id: a.id, rep_id: a.rep_id, rep_name: repNames.get(a.rep_id) ?? null, status: a.status, sla_due_at: a.sla_due_at, assigned_at: a.assigned_at, accepted_at: a.accepted_at } : null };
    });
```

(importe `isLeadVisible` de `../lib/lead-visibility.js`; o early return `if (!enabled || !rows.length) return rows;` continua no topo).

Em `apps/api/src/routes/opportunities/index.ts`, na rota `GET /organizations/:organizationId/opportunities` (linha ~45), troque o `return enrichSalesWorkspace(...)` por:

```ts
      const leadDistributionEnabled = organization.settings.lead_distribution_enabled === true;
      const viewer = resolveLeadVisibility({ role: membership.role, userId: request.user.id, leadDistributionEnabled });
      return enrichSalesWorkspace(db, organizationId, rows, organization.settings.sales_workspace_enabled === true || organization.settings.sales_action_queue_enabled === true,
        leadDistributionEnabled ? { enabled: true, viewer } : undefined);
```

(importe `resolveLeadVisibility` de `../../lib/lead-visibility.js`). Na rota `.../opportunities/:opportunityId/details` e `/tasks/:taskId/details`, antes de devolver, se `viewer.mode === "own"` e o dono do negócio (ou o `assignee_id` da tarefa) pertencer a **outro vendedor** (use `listSalesReps` e `isLeadVisible`), responda `403 { error: "Este lead pertence a outro vendedor" }`. Em `dashboard/today`, filtre `rows` com o mesmo `isLeadVisible` (campo `row.opportunity?.owner_id ?? row.task.assignee_id`) antes de `buildTodayPriorityList`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @aula-agente/api exec vitest run && pnpm --filter @aula-agente/api exec tsc --noEmit`
Expected: PASS na suíte inteira. Os testes existentes de `enrichSalesWorkspace` e das rotas continuam passando porque o novo parâmetro é opcional e fica `undefined` com a flag desligada.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(distribution): API routes, vendor visibility and card enrichment"
```

---

### Task 11: Telas

**Files:**
- Create: `apps/web/src/components/lead-distribution/availability-select.tsx`
- Create: `apps/web/src/components/lead-distribution/assignment-badge.tsx`
- Create: `apps/web/src/components/lead-distribution/assignment-history.tsx`
- Create: `apps/web/src/components/lead-distribution/exceptions-panel.tsx`
- Create: `apps/web/src/components/lead-distribution/format.ts`
- Modify: `apps/web/src/components/opportunities/opportunity-kanban.tsx` (selo no card)
- Modify: `apps/web/src/components/opportunities/opportunity-detail-dialog.tsx` (histórico)
- Modify: `apps/web/src/app/(dashboard)/opportunities/page.tsx` (painel de exceções para gestor)
- Modify: `apps/web/src/components/layout/user-nav.tsx` ou `app-sidebar.tsx` (seletor de disponibilidade)
- Modify: `apps/web/src/app/(dashboard)/settings/page.tsx` (card "Distribuição")
- Modify: `apps/web/src/app/(dashboard)/tasks/page.tsx` e `inbox/page.tsx` (filtro "Minhas")

**Interfaces:**
- Consumes: rotas da Task 10; `apiFetch` de `@/lib/api`; `useOrganization()` (traz `currentOrg`, e o papel do usuário em `currentOrg`/membership, como as outras telas); `OpportunityWithContact` ganha `lead_assignment?: {...} | null`.
- Produces: componentes `AvailabilitySelect`, `AssignmentBadge`, `AssignmentHistory`, `ExceptionsPanel`; helper puro `describeSla(dueAt, now)` em `format.ts`.

O app web não tem suíte automatizada: a única lógica pura (contagem regressiva) ganha teste de unidade em Vitest sem DOM; o resto é validado por `tsc`, `next build` e a verificação manual da Task 12.

- [ ] **Step 1: Write the failing test for the pure helper**

```ts
// apps/web/src/components/lead-distribution/format.test.ts
import { describe, expect, it } from "vitest";
import { describeSla } from "./format";

const now = new Date("2026-10-05T12:00:00Z");
describe("describeSla", () => {
  it("mostra o tempo restante", () => {
    expect(describeSla("2026-10-05T12:15:00Z", now)).toEqual({ label: "15 min", overdue: false });
    expect(describeSla("2026-10-05T12:00:30Z", now)).toEqual({ label: "1 min", overdue: false });
  });
  it("mostra vencido", () => {
    expect(describeSla("2026-10-05T11:55:00Z", now)).toEqual({ label: "Vencido há 5 min", overdue: true });
    expect(describeSla("2026-10-05T12:00:00Z", now)).toEqual({ label: "Vencido há 0 min", overdue: true });
  });
  it("sem prazo, nada a mostrar", () => {
    expect(describeSla(null, now)).toBeNull();
  });
});
```

Run: `pnpm --filter @aula-agente/web exec vitest run src/components/lead-distribution/format.test.ts` — se o pacote web não tiver Vitest, adicione `pnpm --filter @aula-agente/web add -D vitest` e o script `"test": "vitest run"`. Expected: FAIL (módulo inexistente).

- [ ] **Step 2: Write the helper and components**

```ts
// apps/web/src/components/lead-distribution/format.ts
export function describeSla(dueAt: string | null | undefined, now: Date = new Date()): { label: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const diffMin = Math.ceil((Date.parse(dueAt) - now.getTime()) / 60_000);
  if (diffMin > 0) return { label: `${diffMin} min`, overdue: false };
  return { label: `Vencido há ${Math.floor(-diffMin)} min`, overdue: true };
}
```

```tsx
// apps/web/src/components/lead-distribution/availability-select.tsx
"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import type { SalesRep, SalesRepAvailability } from "@aula-agente/shared";

const LABELS: Record<SalesRepAvailability, string> = { available: "Disponível", paused: "Pausado", out: "Fora da distribuição" };

/** Aparece só para quem é vendedor (existe em sales_reps) e quando a distribuição está ligada. */
export function AvailabilitySelect({ userId }: { userId: string }) {
  const { currentOrg } = useOrganization();
  const [rep, setRep] = useState<SalesRep | null>(null);
  const [saving, setSaving] = useState(false);
  const enabled = currentOrg?.settings.lead_distribution_enabled === true;

  useEffect(() => {
    if (!currentOrg || !enabled) return;
    apiFetch(`/organizations/${currentOrg.id}/sales-reps`)
      .then((reps: SalesRep[]) => setRep(reps.find(r => r.user_id === userId) ?? null))
      .catch(() => setRep(null));
  }, [currentOrg, enabled, userId]);

  if (!enabled || !rep || !currentOrg) return null;
  const change = async (availability: SalesRepAvailability) => {
    setSaving(true);
    try {
      const updated = await apiFetch(`/organizations/${currentOrg.id}/sales-reps/${rep.id}/availability`, { method: "PATCH", body: JSON.stringify({ availability }) });
      setRep(updated);
    } finally { setSaving(false); }
  };
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Meu status</span>
      <select aria-label="Minha disponibilidade" className="rounded border bg-background p-1" disabled={saving} value={rep.availability} onChange={e => change(e.target.value as SalesRepAvailability)}>
        {(Object.keys(LABELS) as SalesRepAvailability[]).map(a => <option key={a} value={a}>{LABELS[a]}</option>)}
      </select>
    </label>
  );
}
```

```tsx
// apps/web/src/components/lead-distribution/assignment-badge.tsx
"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import { describeSla } from "./format";

export interface CardAssignment { id: string; rep_id: string | null; rep_name: string | null; status: "pending" | "accepted"; sla_due_at: string | null; assigned_at: string; accepted_at: string | null }

export function AssignmentBadge({ assignment, canAccept, onAccepted }: { assignment: CardAssignment; canAccept: boolean; onAccepted: () => void }) {
  const { currentOrg } = useOrganization();
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  const sla = assignment.status === "pending" ? describeSla(assignment.sla_due_at, now) : null;
  const accept = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!currentOrg) return;
    setBusy(true); setError(null);
    try { await apiFetch(`/lead-assignments/${assignment.id}/accept?organizationId=${currentOrg.id}`, { method: "POST" }); onAccepted(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1 text-xs">
      <span className="font-medium">{assignment.rep_name ?? "Sem vendedor"}</span>
      {assignment.status === "accepted" && <span className="text-muted-foreground">assumido</span>}
      {sla && <span className={sla.overdue ? "text-destructive" : "text-muted-foreground"}>Prazo: {sla.label}</span>}
      {assignment.status === "pending" && canAccept && <Button size="sm" disabled={busy} onClick={accept}>Assumir lead</Button>}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </div>
  );
}
```

```tsx
// apps/web/src/components/lead-distribution/assignment-history.tsx
"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import type { LeadAssignment, SalesRep } from "@aula-agente/shared";

const REASONS: Record<string, string> = { round_robin: "Rodízio", existing_owner: "Já tinha vendedor", sla_redistribution: "SLA estourado", manual: "Reatribuição manual", bulk_reassignment: "Reatribuição em lote", exception: "Exceção" };
const when = (v: string | null) => v ? new Date(v).toLocaleString("pt-BR") : "—";

export function AssignmentHistory({ contactId }: { contactId: string }) {
  const { currentOrg } = useOrganization();
  const [rows, setRows] = useState<LeadAssignment[] | null>(null);
  const [reps, setReps] = useState<SalesRep[]>([]);
  useEffect(() => {
    if (!currentOrg || currentOrg.settings.lead_distribution_enabled !== true) return;
    Promise.all([apiFetch(`/organizations/${currentOrg.id}/contacts/${contactId}/lead-assignments`), apiFetch(`/organizations/${currentOrg.id}/sales-reps`)])
      .then(([h, r]) => { setRows(h); setReps(r); }).catch(() => setRows([]));
  }, [currentOrg, contactId]);
  if (!rows?.length) return null;
  const name = (id: string | null) => reps.find(r => r.id === id)?.display_name ?? "—";
  return (
    <section className="rounded-lg border p-4" aria-label="Histórico de atribuição">
      <h3 className="mb-3 font-medium">Atribuição do lead</h3>
      {rows.map(a => (
        <div key={a.id} className="mb-3 border-l-2 pl-3 text-sm">
          <p className="font-medium">{a.rep_id ? name(a.rep_id) : "Sem vendedor"} · {REASONS[a.reason] ?? a.reason}</p>
          <p className="text-xs text-muted-foreground">Atribuído: {when(a.assigned_at)} · Assumiu: {when(a.accepted_at)}{a.accepted_via ? ` (${a.accepted_via})` : ""}</p>
          {a.sla_breached && <p className="text-xs text-destructive">SLA estourado{a.redistribution_reason ? ` · ${a.redistribution_reason}` : ""}{a.next_assignment_id ? ` → ${name(rows.find(x => x.id === a.next_assignment_id)?.rep_id ?? null)}` : ""}</p>}
          {a.status === "exception" && <p className="text-xs text-destructive">Exceção: {a.exception_reason}{a.resolved_at ? ` · resolvida em ${when(a.resolved_at)}` : ""}</p>}
        </div>
      ))}
    </section>
  );
}
```

```tsx
// apps/web/src/components/lead-distribution/exceptions-panel.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import type { LeadAssignment, SalesRep } from "@aula-agente/shared";

const REASONS: Record<string, string> = {
  no_available_rep: "Nenhum vendedor disponível", all_reps_sla_breached: "Todos estouraram o SLA", invalid_existing_owner: "Dono atual inválido",
  distribution_error: "Erro na distribuição", manual_review: "Conflito: revisão manual",
};

/** Só para gestores (a rota devolve 403 para vendedores e o painel some). */
export function ExceptionsPanel() {
  const { currentOrg } = useOrganization();
  const [items, setItems] = useState<LeadAssignment[] | null>(null);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [target, setTarget] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg || currentOrg.settings.lead_distribution_enabled !== true) return;
    try {
      const [ex, r] = await Promise.all([apiFetch(`/organizations/${currentOrg.id}/lead-assignments/exceptions`), apiFetch(`/organizations/${currentOrg.id}/sales-reps`)]);
      setItems(ex); setReps(r);
    } catch { setItems(null); }
  }, [currentOrg]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  if (!items) return null;
  const assign = async (a: LeadAssignment) => {
    const repId = target[a.id]; if (!repId || !currentOrg) return;
    setError(null);
    try { await apiFetch(`/organizations/${currentOrg.id}/lead-assignments/manual`, { method: "POST", body: JSON.stringify({ conversationId: a.conversation_id, repId }) }); await load(); }
    catch (err) { setError((err as Error).message); }
  };
  return (
    <section aria-label="Leads sem responsável" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
      <h2 className="font-medium">Leads sem responsável <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{items.length}</span></h2>
      {!items.length && <p className="mt-1 text-muted-foreground">Nenhuma exceção no momento.</p>}
      {items.map(a => (
        <div key={a.id} className="mt-3 flex flex-wrap items-center gap-2">
          <span>{REASONS[a.exception_reason ?? ""] ?? a.exception_reason}</span>
          <select aria-label="Escolher vendedor" className="rounded border bg-background p-1" value={target[a.id] ?? ""} onChange={e => setTarget({ ...target, [a.id]: e.target.value })}>
            <option value="">Escolher vendedor…</option>
            {reps.filter(r => r.availability !== "out").map(r => <option key={r.id} value={r.id}>{r.display_name}</option>)}
          </select>
          <Button size="sm" disabled={!target[a.id]} onClick={() => assign(a)}>Atribuir</Button>
        </div>
      ))}
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    </section>
  );
}
```

- [ ] **Step 3: Mount the components**

1. **Card do funil** (`opportunity-kanban.tsx`): no tipo `OpportunityWithContact` adicione `lead_assignment?: CardAssignment | null` (importe o tipo de `../lead-distribution/assignment-badge`). Dentro do card, **antes** do selo `sales_state?.hot`, renderize `{opportunity.lead_assignment && <AssignmentBadge assignment={opportunity.lead_assignment} canAccept onAccepted={onChanged} />}`. Se o card não recebe `onChanged`, passe a função de recarregar já usada pela página (`fetchOpportunities`) pelas props existentes do kanban (`onChanged`/`onSaved`).
2. **Detalhe do lead** (`opportunity-detail-dialog.tsx`): dentro da coluna direita, depois da seção "Histórico", adicione `<AssignmentHistory contactId={opportunity.contact_id} />`.
3. **Página do funil** (`opportunities/page.tsx`): renderize `<ExceptionsPanel />` logo acima do `<section aria-label="Busca e filtros do funil">`.
4. **Seletor de disponibilidade**: em `user-nav.tsx` (ou no cabeçalho do `app-sidebar.tsx`, onde já existe `user`), renderize `<AvailabilitySelect userId={user.id} />`.
5. **Configurações → Distribuição** (`settings/page.tsx`): ao lado dos outros interruptores do funil, adicione um card com (a) o interruptor `lead_distribution_enabled`, que ao **ligar** grava também `lead_distribution_activated_at: new Date().toISOString()` (mesmo padrão de `sales_low_intent_cadence_started_at` na função `toggleWorkspace`); (b) campo numérico `lead_sla_minutes` (padrão 15, mínimo 5, máximo 240); (c) lista de vendedores (via `GET .../sales-reps`) com o estado de cada um editável pelo gestor; (d) texto: "O calendário comercial padrão é segunda a sexta, 08:00–18:00. Para atender aos sábados, configure `business_calendar` (janela de sábado)." — o editor do calendário fica fora desta fase; o valor padrão é aplicado.
6. **Filtro "Minhas"** (tarefas e inbox): em `tasks/page.tsx` e `inbox/page.tsx`, quando `currentOrg.settings.lead_distribution_enabled === true` e o papel do usuário for `agent`, aplique por padrão o filtro "Minhas" (responsável = usuário, ou sem responsável de vendedor), como o inbox já faz com `assigned_to === userId` (linhas 103-107). Deixe o comentário `// Fase 1: filtro de tela; isolamento forte é a fase 2 (RLS)` no ponto.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @aula-agente/web exec vitest run src/components/lead-distribution/format.test.ts && pnpm --filter @aula-agente/web exec tsc --noEmit && (cd apps/web && npx next build)`
Expected: teste PASS, sem erros de tipo, build compila.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(distribution): SLA badge, accept button, history, exceptions panel, availability and settings"
```

---

### Task 12: Runbook, verificação final e publicação

**Files:**
- Create: `docs/runbook-distribuicao-leads.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Runbook: distribuição de leads (rodízio)

Spec: docs/superpowers/specs/2026-10-07-lead-distribution-design.md

## Antes de ligar
1. Migrations aplicadas (`supabase migration list` deve mostrar as três de 20261007 como aplicadas). Só aplicar com autorização: `supabase db push`.
2. Deploy de API, worker e web concluído e saudável. O log do worker mostra "Lead-sla worker started (runs every 60 s)".
3. A flag `lead_distribution_enabled` está ausente/false: nada mudou para os usuários.
4. Márcio convidado como membro `agent` da organização.
5. Criar os vendedores (SQL no editor do Supabase, trocando os UUIDs pelos `user_id` reais dos membros):
   insert into sales_reps (organization_id, user_id, display_name, rotation_order) values
     ('<org>', '<user_marina>', 'Marina', 1), ('<org>', '<user_marcio>', 'Márcio', 2);
6. Conferir o calendário comercial (padrão segunda a sexta 08:00–18:00). Se houver atendimento aos sábados, gravar `settings.business_calendar` com uma janela de sábado (ex.: 08:00–12:00).

## Ligar
Configurações → Distribuição → ligar. O sistema grava `lead_distribution_activated_at`; só handoffs a partir daí entram. A base existente NÃO é redistribuída.

## Validar com handoffs reais (um de cada tipo)
- Rodízio: dois handoffs seguidos vão a vendedores diferentes; o card mostra o vendedor e a contagem regressiva.
- Assumir: o botão "Assumir lead" ou a primeira mensagem do vendedor registram `accepted_at`; a mensagem da Mariana NÃO assume.
- SLA: um lead não assumido é redistribuído ao outro vendedor em até ~1 minuto depois do vencimento (dentro do horário comercial).
- Dono existente: cliente que já é do Márcio volta para ele, sem andar o rodízio.
- Exceção: com os dois pausados, o handoff aparece em "Leads sem responsável".
- Pausar: um vendedor Pausado não recebe novos leads e mantém os atuais. Fora da distribuição não move nenhum lead.

## Consultas úteis
- Tempo handoff → primeira resposta: `select * from lead_response_metrics order by assigned_at desc limit 50;`
- SLAs estourados por vendedor: `select rep_id, count(*) from lead_assignments where sla_breached group by rep_id;`
- Exceções abertas: `select * from lead_assignments where status='exception' and resolved_at is null;`

## Reversão
Desligar `lead_distribution_enabled` em Configurações → Distribuição. O histórico permanece, os leads continuam com seus donos e o `requestHuman` volta a usar o responsável padrão de handoff. Nenhum dado é apagado.

## Limites conhecidos (fase 1)
- O isolamento por vendedor é da aplicação (API e telas), não do banco. Inbox, realtime e a página de tarefas leem direto do Supabase e só têm filtro de tela. Fase 2: RLS por vendedor, com spec própria.
- Reatribuição em lote da carteira não existe (ação administrativa futura e explícita).
- Aviso de exceção é só painel e contador (sem e-mail ou push).
```

- [ ] **Step 2: Run the full verification**

Run: `pnpm build --filter=@aula-agente/shared --filter=@aula-agente/database --filter=@aula-agente/queue && pnpm test && pnpm typecheck && (cd apps/web && npx next build)`
Expected: todas as suítes passam (shared, database com os testes de SQL, agent-runtime, worker, API), typecheck sem erros e build do web compilando. Anote as contagens de testes para o PR.

- [ ] **Step 3: Confirm the flag is still off by default**

Run: `grep -rn "lead_distribution_enabled" supabase/migrations | grep -v "settings->>"` e confira que nenhuma migration liga a flag; `grep -rn "lead_distribution_enabled: true" apps packages --include=*.ts | grep -v test` deve voltar vazio.
Expected: nenhuma ocorrência fora de testes.

- [ ] **Step 4: Commit and publish the branch**

```bash
git add docs/runbook-distribuicao-leads.md
git commit -m "docs(distribution): activation and rollback runbook"
git push -u origin feat/lead-distribution
```

Depois abra o PR (descrição: o que muda, a flag desligada, as 3 migrations pendentes, o limite de isolamento da fase 1 e o resultado dos testes). **Não** faça merge nem aplique migrations sem autorização do usuário: o merge dispara o deploy no EasyPanel e as migrations exigem `supabase db push` autorizado.
```

---

## Self-Review

**1. Spec coverage**

| Spec | Task |
|---|---|
| §4.1 `sales_reps` (campos ativos e reservados) | 3 |
| §4.2 `lead_distribution_state` como única fonte do ponteiro | 3, 4 (teste "mantém o ponteiro no banco") |
| §4.3 `lead_assignments`, índices, imutabilidade | 3 |
| §4.4 `owner_assigned_at`, `last_commercial_activity_at`, `assigned_at` | 3 (colunas), 4 (`owner_assigned_at`, `assigned_at`) |
| §4.5 settings e flag | 2, 6, 11 |
| §5.1 gatilho e idempotência | 4, 7 |
| §5.2 precedência do dono, 30 dias, casos de borda | 4 |
| §5.3 rodízio, ponteiro, pausado/out | 2 (`pickRep`), 4, 5 |
| §5.4 efeitos (conversa, negócio, tarefas) | 4 |
| §5.5 sem vendedor → exceção | 4 |
| §6.1 e §6.1.1 assumir e origem humana | 2, 5, 9 |
| §6.2 calendário (fuso, dias não úteis, sábado configurável) | 1 |
| §6.3 varredura de 60 s, redistribuição, sem vai e volta | 5, 8 |
| §6.4 KPIs | 3 (view) |
| §7 exceções estruturadas e atribuição manual | 4, 5, 10, 11 |
| §8 papéis, visibilidade fase 1, RLS fase 2 registrada | 10, 11, 12 |
| §3 estados (`out` não move lead) | 5 (teste "marcar out não move"), nenhuma função de lote |
| §9 telas | 11 |
| §10 preparação futura | 2 (`pickRep` com contexto), 3 (colunas reservadas), 4 (`p_context`) |
| §12 ativação/reversão | 12 |
| §13 testes | em todas as tasks |

Lacuna conhecida e declarada: `last_commercial_activity_at` é atualizada por **mensagem humana** (em `record_human_message`, Task 5, com teste). **Mudança de etapa e tarefa concluída pelo dono** também seriam atividade comercial relevante, mas tocam fluxos existentes (`opportunity.service`, `task.service`); ficam como follow-up explícito no PR da Task 12, não omitidos em silêncio.

**2. Placeholder scan:** nenhum "TBD/TODO". Os pontos em que o plano manda localizar um trecho existente (linhas de `request-human.ts`, `message-send.service.ts`, `evolution.ts`, `opportunity-kanban.tsx`, `user-nav.tsx`) trazem o código exato a inserir e a âncora textual; só o encaixe visual (qual prop do kanban recarrega a lista) depende de ler o arquivo no momento.

**3. Type consistency:** `computeSlaDueAt(settings, from)`, `distributeLeadForHandoff`, `redistributeAssignment(db, id, Date)`, `recordHumanMessage({ via: "panel" | "phone_echo" })`, `LeadVisibility`, `isLeadVisible(visibility, ownerUserId, repUserIds)` e os nomes de função SQL (`distribute_lead`, `redistribute_assignment`, `accept_assignment`, `record_human_message`, `manual_assign`) são idênticos entre as tasks 4 a 10 e seus testes. Valores de enum (estados, motivos, exceções, `accepted_via`) coincidem entre Task 2, Task 3 (CHECKs) e as telas.

**4. Review Focus:** as cinco entradas de risco (calendário mal configurado, vendedor removido da organização, zero vendedores, mensagem humana de quem não é o vendedor, reprocessamento do mesmo handoff) têm teste nas Tasks 1/6, 4, 4/7, 5 e 4.
