// Cards "Urgente" do funil (cliente esperando a loja). Fontes: as MESMAS do quadro "Atraso no atendimento" (listSlaAlerts e
// listOpenExceptions) e as promessas de retorno vencidas (seller_commitments). A cobertura diz quantos casos do quadro antigo
// não têm card no funil: o quadro só pode sair quando ela ficar zerada (desenho 2026-11-22).
import { getAdminClient, listOpenExceptions, listSlaAlerts } from "@aula-agente/database";
import type { UrgentState } from "@aula-agente/shared";
import { createOrgCache } from "../lib/org-cache.js";

type AssignmentLike = { contact_id: string; conversation_id: string; handoff_at: string; assigned_at: string; reason: string };
type PromiseLike = { contact_id: string; conversation_id: string; due_at: string };
export interface UrgentSources { alerts: AssignmentLike[]; exceptions: AssignmentLike[]; promises: PromiseLike[] }

const sinceOf = (a: AssignmentLike) => (a.reason === "manual" ? a.assigned_at : a.handoff_at ?? a.assigned_at);

export function buildUrgentByContact(src: UrgentSources, now: Date): Map<string, UrgentState> {
  const map = new Map<string, UrgentState>();
  const put = (contactId: string, u: UrgentState) => {
    const prev = map.get(contactId);
    if (!prev || Date.parse(u.since) < Date.parse(prev.since)) map.set(contactId, u);
  };
  for (const a of src.alerts) put(a.contact_id, { reason: "sla", since: sinceOf(a) });
  for (const e of src.exceptions) put(e.contact_id, { reason: "exception", since: sinceOf(e) });
  for (const p of src.promises) if (Date.parse(p.due_at) <= now.getTime()) put(p.contact_id, { reason: "promise", since: p.due_at });
  return map;
}

export function applyUrgent<T extends { contact_id: string; status: string; sales_state?: Record<string, unknown> }>(rows: T[], map: Map<string, UrgentState>): T[] {
  return rows.map((o) => {
    const urgent = o.status === "open" ? map.get(o.contact_id) ?? null : null;
    return urgent ? { ...o, sales_state: { ...(o.sales_state ?? {}), urgent } } : o;
  });
}

export function urgentCoverage(src: UrgentSources, openContactIds: Set<string>) {
  const items = [
    ...src.alerts.map((a) => ({ contactId: a.contact_id, conversationId: a.conversation_id, reason: "sla" as const })),
    ...src.exceptions.map((e) => ({ contactId: e.contact_id, conversationId: e.conversation_id, reason: "exception" as const })),
  ];
  const uncovered = items.filter((i) => !openContactIds.has(i.contactId));
  return { total: items.length, covered: items.length - uncovered.length, uncovered };
}

const URGENT_CACHE_MS = 20_000;
const urgentInputs = createOrgCache<UrgentSources>(URGENT_CACHE_MS);
export function resetUrgentCacheForTests() { urgentInputs.clear(); }

/** Fontes da urgência (cache de 20 s por organização). Promessas: se a tabela ainda não existe (migração não aplicada), nenhuma. */
export function loadUrgentSources(db: ReturnType<typeof getAdminClient>, organizationId: string): Promise<UrgentSources> {
  return urgentInputs.get(organizationId, async () => {
    const [alerts, exceptions] = await Promise.all([listSlaAlerts(db, organizationId), listOpenExceptions(db, organizationId)]);
    let promises: PromiseLike[] = [];
    const { data, error } = await db.from("seller_commitments").select("contact_id, conversation_id, due_at")
      .eq("organization_id", organizationId).is("resolved_at", null).order("due_at").limit(1000);
    if (!error) promises = (data ?? []) as PromiseLike[];
    return { alerts: alerts as unknown as AssignmentLike[], exceptions: exceptions as unknown as AssignmentLike[], promises };
  });
}
