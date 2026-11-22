// Rotina "commitments" (a cada 5 min): compromissos do vendedor.
//  - Proposta enviada (só com evidência forte: evento de etapa ou valor + termo comercial / PDF de proposta) é registrada em
//    proposal_followups; 30 min úteis depois, sem resposta do cliente nem nova mensagem do vendedor, nasce a tarefa INTERNA
//    "Follow-up de proposta". Nada é enviado ao cliente.
//  - Promessa de retorno ("vou verificar e te retorno") vira seller_commitments + tarefa "Retornar ao cliente" com prazo.
//    Mensagem genérica posterior NÃO resolve; resolve: tarefa concluída no CRM, entrega com evidência forte ou negócio fechado.
//  - Métricas: primeira nova mensagem do vendedor, primeira resposta do cliente e resultado do negócio.
// Desenho: docs/superpowers/specs/2026-11-22-followup-promessas-urgente-design.md
import { Worker } from "bullmq";
import {
  QUEUE_NAMES, FUNNEL_STAGE_LABELS, PROMISE_DEFAULT_MINUTES, PROPOSAL_FOLLOWUP_MINUTES, addBusinessMinutes, describeBusinessInstant,
  detectProposalEvidence, detectSellerPromise, isBusinessOpen, isWithinHistoryWindow, resolveBusinessCalendar, toISODateInTimeZone,
  type BusinessCalendar,
} from "@aula-agente/shared";
import { getCommitmentsQueue, getRedisConnection } from "@aula-agente/queue";
import {
  createCommitmentTask, getAdminClient, getOpenOpportunityForContact, getOpportunityStatuses, getProposalStageEventSince, insertProposalFollowup, proposalExistsBetween,
  insertSellerCommitment, listCommitmentsOrganizations, listMessagesAfter, listOpenSellerCommitments, listRecentSellerMessages,
  listTrackedProposalFollowups, resolveCommitmentPendency, supersedeSellerCommitments, taskHasOpenPendency, updateProposalFollowup,
  updateSellerCommitment, type SupabaseClient,
} from "@aula-agente/database";

export const COMMITMENTS_RUN_EVERY_MS = 5 * 60_000;
/** Primeira leitura: 24 h (o histórico mais velho é ignorado para criar algo novo). Depois, só o que chegou desde a última leitura. */
export const SELLER_MESSAGES_LOOKBACK_MS = 24 * 60 * 60_000;
/** Folga do cursor: mensagem gravada com created_at um pouco antes do fim da leitura anterior não se perde (dedupe por chave única). */
const CURSOR_OVERLAP_MS = 10 * 60_000;
/** Uma proposta por conversa nesta janela: etapa movida + várias mensagens em seguida (ou proposta em partes) contam uma vez. */
const PROPOSAL_DEDUPE_WINDOW_MS = 2 * 60 * 60_000;

/** Cursor da leitura por organização (em memória do worker; reinício = relê 24 h, sem duplicar graças às chaves únicas). */
export interface CommitmentsState { lastScan: Map<string, number> }
export const createCommitmentsState = (): CommitmentsState => ({ lastScan: new Map() });
/** Até quando uma proposta é acompanhada para métrica de mensagens (o resultado do negócio segue até 30 dias). */
const PROPOSAL_MESSAGE_TRACK_MS = 7 * 24 * 60 * 60_000;
/** Evento de etapa vale como prova da proposta se ocorreu até 2 h antes da mensagem do vendedor (ou depois dela). */
const STAGE_EVENT_BEFORE_MS = 2 * 60 * 60_000;

export interface SellerMessage {
  id: string; conversationId: string; contactId: string; assignedTo: string | null;
  createdAt: string; waOriginalAt: string | null; content: string; mediaType: string | null; fileName: string | null; sendFailed: boolean;
}
export interface ConvMessage { id: string; role: string; createdAt: string; content: string; mediaType: string | null; fileName: string | null }
export interface ProposalRow {
  id: string; conversationId: string; contactId: string; opportunityId: string | null; ownerUserId: string | null; sellerMessageId: string; sentAt: string;
  reminderTaskId: string | null; firstSellerFollowupAt: string | null; firstCustomerReplyAt: string | null; outcome: string | null;
}
export interface CommitmentRow {
  id: string; conversationId: string; contactId: string; opportunityId: string | null; ownerUserId: string | null; sellerMessageId: string; sentAt: string;
  dueAt: string; taskId: string | null; resolvedAt: string | null;
}
export interface CommitmentsDeps {
  listOrganizations(): Promise<Array<{ id: string; settings: Record<string, unknown> | null }>>;
  /** Mensagens role human_agent desde sinceIso, da mais antiga para a mais nova. */
  listSellerMessages(organizationId: string, sinceIso: string): Promise<SellerMessage[]>;
  /** Mensagens da conversa criadas depois de afterIso (mais antiga primeiro, com limite). */
  messagesAfter(organizationId: string, conversationId: string, afterIso: string): Promise<ConvMessage[]>;
  /** Negócio aberto do contato (dono preferido), ou null. */
  openOpportunity(organizationId: string, contactId: string): Promise<{ id: string; ownerId: string | null } | null>;
  opportunityStatuses(organizationId: string, ids: string[]): Promise<Map<string, string>>;
  /** Último stage_changed para etapa de proposta do negócio desde sinceIso. */
  proposalStageEventSince(organizationId: string, opportunityId: string, sinceIso: string): Promise<{ at: string; stage: string } | null>;
  /** Já existe proposta registrada nesta conversa com sent_at entre fromIso e toIso? */
  recentProposalExists(organizationId: string, conversationId: string, fromIso: string, toIso: string): Promise<boolean>;
  insertProposal(row: Omit<ProposalRow, "id" | "reminderTaskId" | "firstSellerFollowupAt" | "firstCustomerReplyAt" | "outcome"> & { organizationId: string; identifiedBy: "stage_event" | "content"; evidence: string }): Promise<boolean>;
  listTrackedProposals(organizationId: string, sinceIso: string): Promise<ProposalRow[]>;
  updateProposal(organizationId: string, id: string, patch: Record<string, unknown>): Promise<void>;
  insertCommitment(row: Omit<CommitmentRow, "id" | "taskId" | "resolvedAt"> & { organizationId: string; kind: string; phrase: string }): Promise<string | null>;
  supersedeCommitments(organizationId: string, conversationId: string, keepId: string, atIso: string): Promise<void>;
  listOpenCommitments(organizationId: string): Promise<CommitmentRow[]>;
  updateCommitment(organizationId: string, id: string, patch: Record<string, unknown>): Promise<void>;
  createTask(input: {
    organizationId: string; contactId: string; conversationId: string; opportunityId: string | null; ownerId: string; type: "proposal_followup" | "return_customer";
    description: string; reason: string; priority: "normal" | "high"; dueDate: string; dueTime: string | null;
  }): Promise<{ id: string }>;
  /** A tarefa ainda tem pendência aberta deste tipo (tarefa aberta do tipo, ou pendência consolidada do tipo)? */
  taskHasOpenPendency(organizationId: string, taskId: string, type: string): Promise<boolean>;
  /** Encerra só a pendência deste tipo (as demais obrigações da tarefa consolidada continuam). */
  resolvePendency(organizationId: string, taskId: string, type: string, note: string): Promise<void>;
  log: { info(msg: string): void; error(msg: string): void };
}

export interface CommitmentsSummary { organizations: number; proposals: number; reminders: number; promises: number; resolved: number; errors: number }

const CLOSED = new Set(["won", "lost"]);
const errText = (e: unknown) => String((e as { message?: string } | null)?.message ?? e).replace(/\d{8,}/g, "***").slice(0, 200);
const hhmm = (d: Date, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

function promiseDefaultMinutes(settings: Record<string, unknown>): number {
  const v = settings.promise_default_minutes;
  return Number.isInteger(v) && (v as number) >= 15 && (v as number) <= 600 ? (v as number) : PROMISE_DEFAULT_MINUTES;
}

export async function runCommitments(deps: CommitmentsDeps, now = new Date(), state: CommitmentsState = createCommitmentsState()): Promise<CommitmentsSummary> {
  const summary: CommitmentsSummary = { organizations: 0, proposals: 0, reminders: 0, promises: 0, resolved: 0, errors: 0 };
  let orgs: Array<{ id: string; settings: Record<string, unknown> | null }>;
  try { orgs = await deps.listOrganizations(); } catch (err) { summary.errors++; deps.log.error(`commitments: listing organizations failed (${errText(err)})`); return summary; }
  for (const org of orgs) {
    const settings = org.settings ?? {};
    if (settings.commitments_enabled !== true) continue;
    summary.organizations++;
    const calendar = resolveBusinessCalendar(settings.business_calendar);
    try {
      const last = state.lastScan.get(org.id);
      const since = new Date(last !== undefined ? last - CURSOR_OVERLAP_MS : now.getTime() - SELLER_MESSAGES_LOOKBACK_MS);
      await scanSellerMessages(deps, org.id, calendar, promiseDefaultMinutes(settings), now, since, summary);
      state.lastScan.set(org.id, now.getTime());
    }
    catch (err) { summary.errors++; deps.log.error(`commitments: org ${org.id} scan failed (${errText(err)})`); }
    try { await trackProposals(deps, org.id, calendar, now, summary); }
    catch (err) { summary.errors++; deps.log.error(`commitments: org ${org.id} proposals failed (${errText(err)})`); }
    try { await resolveCommitments(deps, org.id, now, summary); }
    catch (err) { summary.errors++; deps.log.error(`commitments: org ${org.id} promises failed (${errText(err)})`); }
  }
  deps.log.info(`commitments: orgs=${summary.organizations} proposals=${summary.proposals} reminders=${summary.reminders} promises=${summary.promises} resolved=${summary.resolved} errors=${summary.errors}`);
  return summary;
}

async function scanSellerMessages(deps: CommitmentsDeps, organizationId: string, calendar: BusinessCalendar, defaultMinutes: number, now: Date, since: Date, summary: CommitmentsSummary) {
  const msgs = await deps.listSellerMessages(organizationId, since.toISOString());
  const oppCache = new Map<string, { id: string; ownerId: string | null } | null>();
  for (const m of msgs) {
    try {
      if (m.sendFailed) continue;
      // Horário original do WhatsApp (mensagem que chegou atrasada) manda; histórico não gera nada novo.
      const sentAt = new Date(m.waOriginalAt ?? m.createdAt);
      if (!Number.isFinite(sentAt.getTime()) || !isWithinHistoryWindow(sentAt, now)) continue;
      if (!oppCache.has(m.contactId)) oppCache.set(m.contactId, await deps.openOpportunity(organizationId, m.contactId));
      const opp = oppCache.get(m.contactId) ?? null;
      const owner = opp?.ownerId ?? m.assignedTo ?? null;

      const promise = detectSellerPromise(m.content, sentAt, calendar, defaultMinutes);
      if (promise && owner) {
        const id = await deps.insertCommitment({
          organizationId, conversationId: m.conversationId, contactId: m.contactId, opportunityId: opp?.id ?? null, ownerUserId: owner,
          sellerMessageId: m.id, sentAt: sentAt.toISOString(), dueAt: promise.dueAt.toISOString(), kind: promise.kind, phrase: promise.phrase,
        });
        if (id) {
          await deps.supersedeCommitments(organizationId, m.conversationId, id, now.toISOString());
          const task = await deps.createTask({
            organizationId, contactId: m.contactId, conversationId: m.conversationId, opportunityId: opp?.id ?? null, ownerId: owner, type: "return_customer",
            description: `Retornar ao cliente: você disse "${promise.phrase}" às ${hhmm(sentAt, calendar.timeZone)}. Prazo: ${describeBusinessInstant(promise.dueAt, calendar)}.`,
            reason: "Promessa de retorno do vendedor ao cliente.", priority: "high",
            dueDate: toISODateInTimeZone(promise.dueAt, calendar.timeZone), dueTime: hhmm(promise.dueAt, calendar.timeZone),
          });
          await deps.updateCommitment(organizationId, id, { task_id: task.id });
          summary.promises++;
        }
      }

      let identified: { by: "stage_event" | "content"; evidence: string } | null = null;
      const ev = detectProposalEvidence({ content: m.content, mediaType: m.mediaType, fileName: m.fileName });
      if (ev.strong && ev.evidence) identified = { by: "content", evidence: ev.evidence };
      else if (opp) {
        const stage = await deps.proposalStageEventSince(organizationId, opp.id, new Date(sentAt.getTime() - STAGE_EVENT_BEFORE_MS).toISOString());
        if (stage && Date.parse(stage.at) <= now.getTime()) {
          identified = { by: "stage_event", evidence: `Etapa movida para ${FUNNEL_STAGE_LABELS[stage.stage] ?? stage.stage} às ${hhmm(new Date(stage.at), calendar.timeZone)}` };
        }
      }
      if (identified && !(await deps.recentProposalExists(organizationId, m.conversationId, new Date(sentAt.getTime() - PROPOSAL_DEDUPE_WINDOW_MS).toISOString(), sentAt.toISOString()))) {
        const inserted = await deps.insertProposal({
          organizationId, conversationId: m.conversationId, contactId: m.contactId, opportunityId: opp?.id ?? null, ownerUserId: owner,
          sellerMessageId: m.id, sentAt: sentAt.toISOString(), identifiedBy: identified.by, evidence: identified.evidence,
        });
        if (inserted) summary.proposals++;
      }
    } catch (err) { summary.errors++; deps.log.error(`commitments: message ${m.id} failed (${errText(err)})`); }
  }
}

async function trackProposals(deps: CommitmentsDeps, organizationId: string, calendar: BusinessCalendar, now: Date, summary: CommitmentsSummary) {
  const rows = await deps.listTrackedProposals(organizationId, new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString());
  if (!rows.length) return;
  const statuses = await deps.opportunityStatuses(organizationId, [...new Set(rows.map((r) => r.opportunityId).filter((x): x is string => !!x))]);
  const open = isBusinessOpen(now, calendar);
  for (const r of rows) {
    try {
      const patch: Record<string, unknown> = {};
      const status = r.opportunityId ? statuses.get(r.opportunityId) ?? null : null;
      if (status && CLOSED.has(status) && !r.outcome) { patch.outcome = status; patch.outcome_at = now.toISOString(); }
      let firstSeller = r.firstSellerFollowupAt;
      let firstCustomer = r.firstCustomerReplyAt;
      const trackMessages = (!firstSeller || !firstCustomer) && now.getTime() - Date.parse(r.sentAt) <= PROPOSAL_MESSAGE_TRACK_MS;
      if (trackMessages) {
        const after = (await deps.messagesAfter(organizationId, r.conversationId, r.sentAt)).filter((x) => x.id !== r.sellerMessageId);
        const s = after.find((x) => x.role === "human_agent");
        const c = after.find((x) => x.role === "contact");
        if (!firstSeller && s) { firstSeller = s.createdAt; patch.first_seller_followup_at = s.createdAt; }
        if (!firstCustomer && c) { firstCustomer = c.createdAt; patch.first_customer_reply_at = c.createdAt; }
      }
      const closed = !!(patch.outcome ?? r.outcome);
      if (!r.reminderTaskId && !firstSeller && !firstCustomer && !closed && r.ownerUserId && open) {
        const due = addBusinessMinutes(new Date(r.sentAt), PROPOSAL_FOLLOWUP_MINUTES, calendar);
        if (now.getTime() >= due.getTime()) {
          const task = await deps.createTask({
            organizationId, contactId: r.contactId, conversationId: r.conversationId, opportunityId: r.opportunityId, ownerId: r.ownerUserId, type: "proposal_followup",
            description: "Proposta enviada há 30 min — avaliar próximo contato. É só um lembrete interno: nada foi enviado ao cliente.",
            reason: "Proposta enviada sem resposta do cliente.", priority: "normal", dueDate: toISODateInTimeZone(now, calendar.timeZone), dueTime: null,
          });
          patch.reminder_task_id = task.id; patch.reminder_created_at = now.toISOString();
          r.reminderTaskId = task.id;
          summary.reminders++;
        }
      } else if (r.reminderTaskId && (firstSeller || firstCustomer || closed) && (await deps.taskHasOpenPendency(organizationId, r.reminderTaskId, "proposal_followup"))) {
        const note = closed ? "O negócio fechou — lembrete de proposta encerrado." : firstCustomer ? "O cliente respondeu — lembrete de proposta encerrado." : "O vendedor voltou a falar com o cliente — lembrete de proposta encerrado.";
        await deps.resolvePendency(organizationId, r.reminderTaskId, "proposal_followup", note);
        summary.resolved++;
      }
      if (Object.keys(patch).length) {
        if (patch.first_seller_followup_at !== undefined) r.firstSellerFollowupAt = firstSeller;
        if (patch.first_customer_reply_at !== undefined) r.firstCustomerReplyAt = firstCustomer;
        await deps.updateProposal(organizationId, r.id, patch);
      }
    } catch (err) { summary.errors++; deps.log.error(`commitments: proposal ${r.id} failed (${errText(err)})`); }
  }
}

async function resolveCommitments(deps: CommitmentsDeps, organizationId: string, now: Date, summary: CommitmentsSummary) {
  const open = await deps.listOpenCommitments(organizationId);
  if (!open.length) return;
  const statuses = await deps.opportunityStatuses(organizationId, [...new Set(open.map((c) => c.opportunityId).filter((x): x is string => !!x))]);
  for (const c of open) {
    try {
      let resolution: "opportunity_closed" | "task_completed" | "delivered" | null = null;
      const status = c.opportunityId ? statuses.get(c.opportunityId) ?? null : null;
      if (status && CLOSED.has(status)) resolution = "opportunity_closed";
      else if (c.taskId && !(await deps.taskHasOpenPendency(organizationId, c.taskId, "return_customer"))) resolution = "task_completed";
      else {
        // Só entrega com evidência comercial forte resolve; "ok", "bom dia", "tô vendo" NÃO.
        const after = (await deps.messagesAfter(organizationId, c.conversationId, c.sentAt)).filter((x) => x.id !== c.sellerMessageId);
        if (after.some((x) => x.role === "human_agent" && detectProposalEvidence({ content: x.content, mediaType: x.mediaType, fileName: x.fileName }).strong)) resolution = "delivered";
      }
      if (!resolution) continue;
      await deps.updateCommitment(organizationId, c.id, { resolved_at: now.toISOString(), resolution });
      if (c.taskId && resolution !== "task_completed") {
        const note = resolution === "delivered" ? "Retorno prometido entregue ao cliente." : "O negócio fechou — retorno prometido encerrado.";
        await deps.resolvePendency(organizationId, c.taskId, "return_customer", note);
      }
      summary.resolved++;
    } catch (err) { summary.errors++; deps.log.error(`commitments: commitment ${c.id} failed (${errText(err)})`); }
  }
}

export function buildCommitmentsDeps(db: SupabaseClient = getAdminClient()): CommitmentsDeps {
  return {
    listOrganizations: () => listCommitmentsOrganizations(db),
    listSellerMessages: (org, since) => listRecentSellerMessages(db, org, since),
    messagesAfter: (org, conv, after) => listMessagesAfter(db, org, conv, after),
    openOpportunity: (org, contact) => getOpenOpportunityForContact(db, org, contact),
    opportunityStatuses: (org, ids) => (ids.length ? getOpportunityStatuses(db, org, ids) : Promise.resolve(new Map())),
    proposalStageEventSince: (org, opp, since) => getProposalStageEventSince(db, org, opp, since),
    recentProposalExists: (org, conv, from, to) => proposalExistsBetween(db, org, conv, from, to),
    insertProposal: (row) => insertProposalFollowup(db, row),
    listTrackedProposals: (org, since) => listTrackedProposalFollowups(db, org, since),
    updateProposal: (org, id, patch) => updateProposalFollowup(db, org, id, patch),
    insertCommitment: (row) => insertSellerCommitment(db, row),
    supersedeCommitments: (org, conv, keep, at) => supersedeSellerCommitments(db, org, conv, keep, at),
    listOpenCommitments: (org) => listOpenSellerCommitments(db, org),
    updateCommitment: (org, id, patch) => updateSellerCommitment(db, org, id, patch),
    createTask: (i) => createCommitmentTask(db, i),
    taskHasOpenPendency: (org, id, type) => taskHasOpenPendency(db, org, id, type),
    resolvePendency: (org, id, type, note) => resolveCommitmentPendency(db, org, id, type, note),
    log: console,
  };
}

export function startCommitmentsWorker() {
  const state = createCommitmentsState();
  const worker = new Worker(QUEUE_NAMES.COMMITMENTS, async () => {
    await runCommitments(buildCommitmentsDeps(), new Date(), state);
  }, { connection: getRedisConnection(), concurrency: 1 });
  getCommitmentsQueue().upsertJobScheduler("commitments-scheduler", { every: COMMITMENTS_RUN_EVERY_MS }, { name: "run-commitments" });
  worker.on("failed", (job, err) => console.error(`Commitments job ${job?.id} failed:`, err.message));
  console.log("Commitments worker started (runs every 5 min)");
  return worker;
}
