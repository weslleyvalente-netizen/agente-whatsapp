import { Worker } from "bullmq";
import {
  QUEUE_NAMES, buildCustomerNudgeTask, CUSTOMER_NUDGE_MAX_AGE_MS, CUSTOMER_NUDGE_MAX_NEW_PER_RUN, decideCustomerNudge, isBusinessOpen,
  pickFunnelOpportunity, funnelConversationHref, resolveBusinessCalendar, toISODateInTimeZone, type BusinessCalendar,
} from "@aula-agente/shared";
import { getCustomerNudgeQueue, getRedisConnection } from "@aula-agente/queue";
import {
  claimPushDedupe, completeNudgeTask, createTaskWithDedup, getAdminClient, getLastConversationMessage, getLastCustomerMessage, getMessageText, hasFrozenContact,
  hasPushSubscription, hasSellerMessageAfter, isPushConfigured, listContactIdsWithOpenOpportunity, listCurrentMemberIds, listCustomerNudgeOrganizations,
  listNudgeTasksByConversation, listOpenNudgeTasks, listOpenOpportunitiesForNudge, listOpenOpportunityIds, listRecentConversationsForContacts,
  releasePushDedupe, recordNudgeTouch, sendPushToUser, type SupabaseClient,
  type NudgeConversation, type NudgeMessage, type NudgeOpportunity, type NudgeOrganization, type NudgeTaskRef, type OpenNudgeTask, type PushPayload,
} from "@aula-agente/database";

const RUN_EVERY_MS = 30 * 60_000;
const OPEN_STATUSES = ["pending", "in_progress", "rescheduled"];

/**
 * Recusa explícita do cliente: só frases fechadas, a mensagem INTEIRA. "ok/obrigado" NÃO é recusa (a cliente que agradece e some deve ser cutucada),
 * e "não tem problema", "não tenho o RG aqui", "não vou conseguir hoje", "não quero parcela alta" também não.
 */
const REFUSAL = new RegExp("^(" + [
  "sem interesse", "(eu )?nao tenho (mais )?interesse( no (consorcio|financiamento|plano|negocio))?", "(eu )?nao (tenho|tinha) mais interesse",
  "(eu )?desisti( do (consorcio|financiamento|negocio))?", "desisti", "ja (comprei|fechei|resolvi)( (tudo|isso|em outro lugar|em outra empresa))?",
  "(eu )?nao quero mais", "(eu )?nao vou mais (comprar|fechar)", "(eu )?nao vou (comprar|fechar)",
  "pode (encerrar|cancelar)( o (atendimento|contato|pedido|cadastro))?",
].join("|") + ")( obrigad[oa])?$");
export function isCustomerRefusal(content: string): boolean {
  const text = content.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= 60 && REFUSAL.test(text);
}

export interface NudgeDeps {
  listOrganizations(): Promise<NudgeOrganization[]>;
  listOpenOpportunities(organizationId: string): Promise<NudgeOpportunity[]>;
  listConversations(organizationId: string, contactIds: string[], sinceIso: string): Promise<NudgeConversation[]>;
  lastMessage(organizationId: string, conversationId: string): Promise<{ role: string; createdAt: string } | null>;
  lastCustomerMessage(organizationId: string, conversationId: string): Promise<NudgeMessage | null>;
  /** Texto de uma mensagem: só consultado quando a tarefa já sairia (filtro de recusa). */
  messageText(organizationId: string, messageId: string): Promise<string>;
  /** O dono ainda é membro da organização? Ex-membro = sem dono. */
  isMember(organizationId: string, userId: string): Promise<boolean>;
  nudgeTasks(organizationId: string, conversationId: string): Promise<NudgeTaskRef[]>;
  isFrozen(organizationId: string, contactId: string): Promise<boolean>;
  /** `pendencyAdded`: com a consolidação ligada, o cutucar entrou como pendência numa tarefa já aberta do negócio (não é "tarefa já aberta"). */
  createTask(input: { organizationId: string; contactId: string; conversationId: string; opportunityId: string; ownerId: string; description: string; reason: string; priority: "normal" | "high"; dueDate: string }): Promise<{ id: string; wasUpdated: boolean; pendencyAdded?: boolean }>;
  /** Registra o toque (evento na tarefa que o carrega): a contagem de toques não depende da pendência continuar na lista consolidada. */
  recordTouch(organizationId: string, taskId: string, conversationId: string, touch: number): Promise<void>;
  contactName(organizationId: string, contactId: string): Promise<string | null>;
  // Resolução automática
  listOpenNudgeTasks(organizationId: string): Promise<OpenNudgeTask[]>;
  openOpportunityIds(organizationId: string, ids: string[]): Promise<Set<string>>;
  contactsWithOpenOpportunity(organizationId: string, contactIds: string[]): Promise<Set<string>>;
  sellerMessageAfter(organizationId: string, conversationId: string, afterIso: string): Promise<boolean>;
  completeTask(organizationId: string, taskId: string, note: string): Promise<void>;
  // Push ao vendedor
  canReceivePush(organizationId: string, userId: string): Promise<boolean>;
  claimPushDedupe(key: string, userId: string): Promise<boolean>;
  releasePushDedupe(keys: string[]): Promise<void>;
  sendPush(organizationId: string, userId: string, payload: PushPayload): Promise<number>;
  log: { info(msg: string): void; error(msg: string): void };
}

export interface NudgeSummary {
  organizations: number;
  /** Negócios abertos vistos / conversas avaliadas (chegaram a olhar a última mensagem) / pendências criadas (`created`, das quais `grouped` entraram numa tarefa consolidada já aberta). */
  opportunities: number; evaluated: number; created: number; grouped: number; resolved: number; pushed: number; errors: number;
  /** Bloqueios por motivo (regra: not_due_yet, waiting_on_us, frozen, before_baseline…; ambiente: consolidation_not_activated, run_cap…). */
  skipped: Record<string, number>;
}

/** Um push por TOQUE: numa tarefa consolidada o mesmo taskId carrega vários toques ao longo do tempo. */
export const nudgePushDedupeKey = (taskId: string, touch?: number) => (touch === undefined ? `nudge:${taskId}` : `nudge:${taskId}:${touch}`);
const errText = (e: unknown) => String((e as { message?: string } | null)?.message ?? e).replace(/\d{8,}/g, "***").slice(0, 200);

/**
 * Vários negócios abertos no mesmo contato: escolhe um só (dono, waiting_on e opportunity_id da tarefa vêm dele) —
 * prefere o que tem dono e, entre eles, o de interação mais recente. Não cria uma tarefa por negócio.
 */
/** Dono do negócio aberto do contato: prefere negócio com dono e, entre eles, o de interação mais recente. */
function pickOpportunity(list: NudgeOpportunity[]): NudgeOpportunity {
  return pickFunnelOpportunity(list)!;
}

export async function runCustomerNudge(deps: NudgeDeps, now = new Date()): Promise<NudgeSummary> {
  const summary: NudgeSummary = { organizations: 0, opportunities: 0, evaluated: 0, created: 0, grouped: 0, resolved: 0, pushed: 0, errors: 0, skipped: {} };
  const skip = (reason: string) => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; };

  let orgs: NudgeOrganization[];
  try { orgs = await deps.listOrganizations(); } catch (err) { deps.log.error(`customer-nudge: listing organizations failed (${errText(err)})`); summary.errors++; return summary; }
  // Defesa extra: só quem tem a flag === true.
  orgs = orgs.filter((o) => o.settings?.customer_nudge_enabled === true);

  for (const org of orgs) {
    summary.organizations++;
    const settings = org.settings as {
      business_calendar?: unknown; push_notifications_enabled?: unknown; task_consolidation_by_opportunity_enabled?: unknown;
      customer_nudge_consolidated_enabled?: unknown; customer_nudge_baseline_at?: unknown; customer_nudge_max_new_per_run?: unknown;
    };
    const calendar = resolveBusinessCalendar(settings.business_calendar);
    try { summary.resolved += await resolveNudgeTasks(deps, org.id); }
    catch (err) { summary.errors++; deps.log.error(`customer-nudge: org ${org.id} auto-resolve failed (${errText(err)})`); }
    // Consolidação por negócio ligada: o cutucar entra como UMA pendência na tarefa consolidada do negócio (mesmo motor, sem tarefa paralela).
    // Ativação explícita (=== true): sem ela a organização continua sem cutucar, exatamente como antes — nada dispara na implantação.
    const consolidating = settings.task_consolidation_by_opportunity_enabled === true;
    if (consolidating && settings.customer_nudge_consolidated_enabled !== true) {
      skip("consolidation_not_activated");
      deps.log.error(`customer-nudge: org ${org.id} skipped — consolidação de tarefas ligada e customer_nudge_consolidated_enabled !== true; o cutucar não cria pendências nessa configuração`);
      continue;
    }
    const baselineMs = typeof settings.customer_nudge_baseline_at === "string" ? Date.parse(settings.customer_nudge_baseline_at) : NaN;
    const baselineAt = Number.isFinite(baselineMs) ? new Date(baselineMs) : null;
    const cap = Number.isInteger(settings.customer_nudge_max_new_per_run) && (settings.customer_nudge_max_new_per_run as number) >= 1
      ? Math.min(settings.customer_nudge_max_new_per_run as number, 100) : CUSTOMER_NUDGE_MAX_NEW_PER_RUN;
    // Só cria/avisa dentro do expediente, para a tarefa aparecer de manhã.
    if (!isBusinessOpen(now, calendar)) { skip("outside_business_hours"); continue; }
    try { await createNudgeTasks(deps, org.id, calendar, settings.push_notifications_enabled === true, now, summary, skip, { baselineAt, cap }); }
    catch (err) { summary.errors++; deps.log.error(`customer-nudge: org ${org.id} failed (${errText(err)})`); }
  }
  deps.log.info(`customer-nudge: orgs=${summary.organizations} opps=${summary.opportunities} evaluated=${summary.evaluated} created=${summary.created} grouped=${summary.grouped} resolved=${summary.resolved} pushed=${summary.pushed} errors=${summary.errors} skipped=${JSON.stringify(summary.skipped)}`);
  return summary;
}

/** Conclui, com nota, o lembrete que já cumpriu o papel: o vendedor cutucou depois da tarefa ou o negócio deixou de estar aberto. */
async function resolveNudgeTasks(deps: NudgeDeps, organizationId: string): Promise<number> {
  const tasks = await deps.listOpenNudgeTasks(organizationId);
  if (!tasks.length) return 0;
  const oppIds = [...new Set(tasks.map((t) => t.opportunityId).filter((x): x is string => !!x))];
  const noOppContacts = [...new Set(tasks.filter((t) => !t.opportunityId).map((t) => t.contactId))];
  const openOpps = oppIds.length ? await deps.openOpportunityIds(organizationId, oppIds) : new Set<string>();
  const openContacts = noOppContacts.length ? await deps.contactsWithOpenOpportunity(organizationId, noOppContacts) : new Set<string>();
  let resolved = 0;
  for (const t of tasks) {
    try {
      const stillOpen = t.opportunityId ? openOpps.has(t.opportunityId) : openContacts.has(t.contactId);
      let note: string | null = null;
      if (!stillOpen) note = "O negócio deixou de estar aberto — lembrete de cutucar encerrado.";
      else if (t.conversationId && (await deps.sellerMessageAfter(organizationId, t.conversationId, t.createdAt))) note = "Vendedor já cutucou o cliente (mensagem enviada depois da tarefa).";
      if (!note) continue;
      await deps.completeTask(organizationId, t.id, note);
      resolved++;
    } catch (err) { deps.log.error(`customer-nudge: resolving task ${t.id} failed (${errText(err)})`); }
  }
  return resolved;
}

async function createNudgeTasks(
  deps: NudgeDeps, organizationId: string, calendar: BusinessCalendar, pushEnabled: boolean, now: Date, summary: NudgeSummary, skip: (r: string) => void,
  opts: { baselineAt: Date | null; cap: number } = { baselineAt: null, cap: CUSTOMER_NUDGE_MAX_NEW_PER_RUN },
) {
  const opps = await deps.listOpenOpportunities(organizationId);
  summary.opportunities += opps.length;
  const byContact = new Map<string, NudgeOpportunity[]>();
  for (const o of opps) { const list = byContact.get(o.contactId); if (list) list.push(o); else byContact.set(o.contactId, [o]); }
  if (!byContact.size) return;
  const since = new Date(now.getTime() - CUSTOMER_NUDGE_MAX_AGE_MS);
  const convs = await deps.listConversations(organizationId, [...byContact.keys()], since.toISOString());
  // Mais recentes primeiro: com o teto de tarefas por execução, o que acabou de esfriar tem prioridade.
  convs.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || a.id.localeCompare(b.id));
  const todayISODate = toISODateInTimeZone(now, calendar.timeZone);
  let createdNow = 0;
  // Cutucar aberto por negócio (ou por contato, se a tarefa não tem negócio): vale para qualquer conversa do mesmo negócio.
  const openTasks = await deps.listOpenNudgeTasks(organizationId);
  const openOppIds = new Set(openTasks.map((t) => t.opportunityId).filter((x): x is string => !!x));
  const openContactIds = new Set(openTasks.filter((t) => !t.opportunityId).map((t) => t.contactId));
  const memberCache = new Map<string, boolean>();

  for (const conv of convs) {
    if (createdNow >= opts.cap) { skip("run_cap"); break; }
    try {
      summary.evaluated++;
      const last = await deps.lastMessage(organizationId, conv.id);
      // Só o vendedor falando por último conta (mensagem da IA, "agent", não é vendedor).
      if (!last || last.role !== "human_agent") { skip("not_seller_last"); continue; }
      const opp = pickOpportunity(byContact.get(conv.contactId) ?? []);
      let ownerId = opp.ownerId ?? conv.assignedTo;
      // Dono que saiu da organização conta como sem dono.
      if (ownerId) {
        if (!memberCache.has(ownerId)) memberCache.set(ownerId, await deps.isMember(organizationId, ownerId));
        if (!memberCache.get(ownerId)) ownerId = null;
      }
      const [tasks, lastCustomer] = await Promise.all([deps.nudgeTasks(organizationId, conv.id), deps.lastCustomerMessage(organizationId, conv.id)]);
      const cycleTasks = tasks.filter((t) => !lastCustomer || t.createdAt > lastCustomer.createdAt);
      const priorTouches = cycleTasks.length;
      // Momento do toque anterior: o mais tardio entre criação e conclusão da tarefa mais recente do ciclo.
      const lastNudgeMs = Math.max(0, ...cycleTasks.flatMap((t) => [Date.parse(t.createdAt), t.completedAt ? Date.parse(t.completedAt) : 0]).filter((n) => Number.isFinite(n)));
      const lastNudgeAt = cycleTasks.length && lastNudgeMs > 0 ? new Date(lastNudgeMs).toISOString() : null;
      const facts = {
        now, calendar, lastSellerMessageAt: new Date(last.createdAt), priorTouches, lastNudgeAt, ownerId,
        baselineAt: opts.baselineAt, hasOpenTask: openOppIds.has(opp.id) || openContactIds.has(conv.contactId) || tasks.some((t) => OPEN_STATUSES.includes(t.status)), frozen: false,
        opportunity: { waiting_on: opp.waitingOn, waiting_on_until: opp.waitingOnUntil }, todayISODate, customerRefused: false,
      };
      // Primeira passada barata; congelado e encerramento só são consultados quando a tarefa sairia.
      const first = decideCustomerNudge(facts);
      if (first.action === "skip") { skip(first.reason); continue; }
      const frozen = await deps.isFrozen(organizationId, conv.contactId);
      // Só recusa explícita pula; "ok/obrigado" seguido de silêncio do cliente continua sendo cutucado.
      const customerRefused = !frozen && !!lastCustomer && (!lastCustomer.mediaType || lastCustomer.mediaType === "text")
        && isCustomerRefusal(await deps.messageText(organizationId, lastCustomer.id));
      const decision = decideCustomerNudge({ ...facts, frozen, customerRefused });
      if (decision.action === "skip") { skip(decision.reason); continue; }

      const text = buildCustomerNudgeTask(decision.touch, decision.ladderDays);
      const { id: taskId, wasUpdated, pendencyAdded } = await deps.createTask({
        organizationId, contactId: conv.contactId, conversationId: conv.id, opportunityId: opp.id, ownerId: ownerId!,
        description: text.description, reason: text.reason, priority: text.priority, dueDate: todayISODate,
      });
      // wasUpdated sem pendência nova = já existia o mesmo cutucar aberto (refresh). Com consolidação, pendencyAdded=true é criação.
      if (wasUpdated && pendencyAdded !== true) { skip("task_already_open"); continue; }
      createdNow++; summary.created++;
      if (wasUpdated) summary.grouped++;
      try { await deps.recordTouch(organizationId, taskId, conv.id, decision.touch); }
      catch (err) { summary.errors++; deps.log.error(`customer-nudge: touch not recorded task ${taskId} conv ${conv.id} (${errText(err)})`); }
      openOppIds.add(opp.id);
      deps.log.info(`customer-nudge: task ${taskId} org ${organizationId} conv ${conv.id} touch ${decision.touch}`);
      if (pushEnabled && await pushToOwner(deps, organizationId, ownerId!, conv, taskId, decision.touch)) summary.pushed++;
    } catch (err) {
      summary.errors++;
      deps.log.error(`customer-nudge: conv ${conv.id} failed (${errText(err)})`);
    }
  }
}

/** Push "Cutucar cliente" ao vendedor dono; qualquer falha é registrada e nunca derruba a execução. */
async function pushToOwner(deps: NudgeDeps, organizationId: string, userId: string, conv: NudgeConversation, taskId: string, touch: number): Promise<boolean> {
  const key = nudgePushDedupeKey(taskId, touch);
  try {
    if (!(await deps.canReceivePush(organizationId, userId))) return false;
    if (!(await deps.claimPushDedupe(key, userId))) return false;
    const name = (await deps.contactName(organizationId, conv.contactId))?.trim() || "Sem nome";
    const sent = await deps.sendPush(organizationId, userId, { title: "Cutucar cliente", body: `${name} parou de responder. Toque para retomar a conversa.`, url: funnelConversationHref(conv.id), tag: conv.id });
    if (sent <= 0) { await deps.releasePushDedupe([key]).catch(() => {}); return false; }
    return true;
  } catch (err) {
    await deps.releasePushDedupe([key]).catch(() => {});
    deps.log.error(`customer-nudge: push failed task ${taskId} (${errText(err)})`);
    return false;
  }
}

export function buildRealDeps(db: SupabaseClient = getAdminClient(), overrides: Partial<NudgeDeps> = {}): NudgeDeps {
  return {
    listOrganizations: () => listCustomerNudgeOrganizations(db),
    listOpenOpportunities: (orgId) => listOpenOpportunitiesForNudge(db, orgId),
    listConversations: (orgId, contactIds, sinceIso) => listRecentConversationsForContacts(db, orgId, contactIds, sinceIso),
    lastMessage: (orgId, conversationId) => getLastConversationMessage(db, orgId, conversationId),
    lastCustomerMessage: (orgId, conversationId) => getLastCustomerMessage(db, orgId, conversationId),
    messageText: (orgId, messageId) => getMessageText(db, orgId, messageId),
    isMember: async (orgId, userId) => (await listCurrentMemberIds(db, orgId, [userId])).has(userId),
    nudgeTasks: (orgId, conversationId) => listNudgeTasksByConversation(db, orgId, conversationId),
    isFrozen: (orgId, contactId) => hasFrozenContact(db, orgId, contactId, true),
    createTask: async (i) => {
      const { task, wasUpdated, pendencyAdded } = await createTaskWithDedup(db, {
        organization_id: i.organizationId, contact_id: i.contactId, conversation_id: i.conversationId, opportunity_id: i.opportunityId,
        type: "customer_nudge", description: i.description, reason: i.reason, priority: i.priority, due_date: i.dueDate,
        created_by_type: "ai", created_by_id: null, assignee_type: "human", assignee_id: i.ownerId, assign_on_merge: true,
      });
      return { id: task.id, wasUpdated, pendencyAdded };
    },
    contactName: async (orgId, contactId) => {
      const { data, error } = await db.from("wa_contacts").select("name").eq("organization_id", orgId).eq("id", contactId).maybeSingle();
      if (error) throw error;
      return (data as { name: string | null } | null)?.name ?? null;
    },
    recordTouch: (orgId, taskId, conversationId, touch) => recordNudgeTouch(db, orgId, taskId, conversationId, touch),
    listOpenNudgeTasks: (orgId) => listOpenNudgeTasks(db, orgId),
    openOpportunityIds: (orgId, ids) => listOpenOpportunityIds(db, orgId, ids),
    contactsWithOpenOpportunity: (orgId, contactIds) => listContactIdsWithOpenOpportunity(db, orgId, contactIds),
    sellerMessageAfter: (orgId, conversationId, afterIso) => hasSellerMessageAfter(db, orgId, conversationId, afterIso),
    completeTask: (orgId, taskId, note) => completeNudgeTask(db, orgId, taskId, note),
    canReceivePush: async (orgId, userId) => {
      if (!isPushConfigured()) return false;
      if (!(await listCurrentMemberIds(db, orgId, [userId])).has(userId)) return false;
      return hasPushSubscription(db, orgId, userId);
    },
    claimPushDedupe: (key, userId) => claimPushDedupe(db, key, userId),
    releasePushDedupe: (keys) => releasePushDedupe(db, keys),
    sendPush: async (orgId, userId, payload) => (await sendPushToUser(db, userId, payload, { organizationId: orgId })).sent,
    log: console,
    ...overrides,
  };
}

export function startCustomerNudgeWorker() {
  const worker = new Worker(QUEUE_NAMES.CUSTOMER_NUDGE, async () => {
    await runCustomerNudge(buildRealDeps());
  }, { connection: getRedisConnection(), concurrency: 1 });
  getCustomerNudgeQueue().upsertJobScheduler("customer-nudge-scheduler", { every: RUN_EVERY_MS }, { name: "run-customer-nudge" });
  worker.on("failed", (job, err) => console.error(`Customer-nudge job ${job?.id} failed:`, err.message));
  console.log("Customer-nudge worker started (runs every 30 min)");
  return worker;
}
