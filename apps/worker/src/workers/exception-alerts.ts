import {
  buildExceptionAlertMessage, evaluateAlertReadiness, planExceptionAlerts, recipientEligibleStages, resolveBusinessCalendar,
  type AlertReadiness, type AlertReadinessFacts, type BusinessCalendar, type ExceptionAlertMessage, type ExceptionAlertStage, type ExceptionAlertsMode, type OrganizationSettings,
} from "@aula-agente/shared";
import {
  claimAlertSlot, finishAlertSlot, getAdminClient, getAllOrganizations, getOrganizationById, listRecordedAlertSlots, listSalesReps,
  listCurrentMemberIds, loadAlertReadinessRecipients, loadTriageItems, markAlertSending, releaseAlertSlot, releaseStaleAlertClaims, sendPushToUser, isPushConfigured,
  type AlertLedgerClaim, type RecordedAlertSlot, type TriageItem,
} from "@aula-agente/database";

// P0a: escada de alertas de exceção de SLA (0/15/30/60 min úteis). Nasce DESLIGADA: só roda para organizações com
// settings.exception_alerts_mode = "shadow" | "on" E settings.exception_alerts_activated_at preenchido (sem retroativo).
//  - shadow: calcula e REGISTRA no livro o que enviaria (canal "shadow"); não envia nada.
//  - on: só envia se a PRONTIDÃO passar (destinatário administrativo válido, membro atual, com aparelho push, push configurado).
// Controle POR DESTINATÁRIO: cada (exceção, estágio, canal, destinatário) é uma linha do livro. Quem não recebeu (falha, sem registro)
// continua elegível no ciclo seguinte, mesmo que outro destinatário já tenha recebido aquele estágio.
// Modos separados: linhas "shadow" nunca contam quando o modo é "on" (a passagem shadow -> on não suprime aviso devido).
// Envio sem duplicar: reserva (INSERT único) -> marca send_started_at -> push -> confirma (com repetição). Reserva marcada e sem confirmação
// NUNCA é reenviada (vira 'skipped' unconfirmed_send); o `tag` do push também colapsa um eventual duplicado no aparelho.
// Não escreve em lead_assignments nem toca o rodízio.

export const SWEEP_EVERY_MS = 60_000;
export const STALE_CLAIM_MS = 5 * 60_000;
export const FINISH_ATTEMPTS = 3;
export const UNCONFIRMED_WARNING = "exception-alerts: AVISO resultado DESCONHECIDO: o push pode ter sido entregue OU nunca ter começado. Reserva convertida em unconfirmed_send; este estágio NÃO será reenviado ao destinatário";

/**
 * "failed" = há EVIDÊNCIA de que nada foi entregue (provedor rejeitou com 4xx, DNS/recusa de conexão, erro antes de enviar): libera para nova tentativa.
 * "unknown" = o envio pode ter sido aceito (timeout, conexão derrubada, 5xx, resposta perdida, exceção sem forma conhecida): a reserva é PRESERVADA e nunca reenviada.
 */
type PushOutcome = "sent" | "no_device" | "unconfigured" | "failed" | "unknown";

export interface ExceptionAlertDeps {
  now(): Date;
  listOrganizations(): Promise<Array<{ id: string; settings: Partial<OrganizationSettings> }>>;
  /** Relê o modo a cada item: desligar interrompe um ciclo em andamento. */
  currentMode(organizationId: string): Promise<ExceptionAlertsMode>;
  loadItems(organizationId: string, calendar: BusinessCalendar, now: Date): Promise<TriageItem[]>;
  recordedSlots(assignmentIds: string[]): Promise<Map<string, RecordedAlertSlot[]>>;
  managerIds(organizationId: string): Promise<string[]>;
  repUserIds(organizationId: string): Promise<string[]>;
  /** Fatos para a prontidão (destinatários, papel, aparelhos, push configurado). */
  readinessFacts(organizationId: string): Promise<AlertReadinessFacts>;
  claim(c: AlertLedgerClaim): Promise<{ id: number } | null>;
  markSending(id: number): Promise<boolean>;
  finish(id: number, status: "sent" | "skipped", detail?: Record<string, unknown>): Promise<void>;
  release(id: number): Promise<void>;
  releaseStale(): Promise<{ released: number; unconfirmed: number; unconfirmedRows?: Array<{ id: number; assignmentId: string; stage: number }> }>;
  sendPush(organizationId: string, userId: string, message: ExceptionAlertMessage, tag: string): Promise<PushOutcome>;
  sleep(ms: number): Promise<void>;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

export interface ExceptionAlertSummary {
  organizations: number; evaluated: number; sent: number; shadowed: number; skipped: number; noRecipients: number; released: number;
  unconfirmed: number; notReady: number; failed: number;
}

/** Quais linhas do livro contam como "já tratado" para um destinatário, conforme o modo. Shadow e on nunca se misturam. */
export function countsForMode(mode: "shadow" | "on", slot: RecordedAlertSlot): boolean {
  return mode === "shadow" ? slot.channel === "shadow" : slot.channel !== "shadow";
}

/** Traduz o resultado por aparelho em um desfecho único por destinatário. Exportada para o ensaio usar a MESMA regra do código real. */
export function pushResultToOutcome(r: { sent: number; failed: number; ambiguous?: number; skipped?: boolean }): PushOutcome {
  if (r.skipped) return "unconfigured";
  if (r.sent > 0) return "sent"; // ao menos um aparelho aceitou: não se repete (falha parcial não gera reenvio)
  if ((r.ambiguous ?? 0) > 0) return "unknown"; // nenhum confirmou e algum pode ter aceitado
  return r.failed > 0 ? "failed" : "no_device";
}

export async function runExceptionAlertsOnce(deps: ExceptionAlertDeps): Promise<ExceptionAlertSummary> {
  const summary: ExceptionAlertSummary = { organizations: 0, evaluated: 0, sent: 0, shadowed: 0, skipped: 0, noRecipients: 0, released: 0, unconfirmed: 0, notReady: 0, failed: 0 };
  let orgs: Awaited<ReturnType<ExceptionAlertDeps["listOrganizations"]>>;
  try { orgs = await deps.listOrganizations(); } catch (err) { deps.log.error("exception-alerts: falha ao listar organizações", (err as Error)?.name); return summary; }
  const enabled = orgs.filter(o => o.settings.exception_alerts_mode === "shadow" || o.settings.exception_alerts_mode === "on");
  if (!enabled.length) return summary;
  try {
    const r = await deps.releaseStale(); summary.released = r.released; summary.unconfirmed = r.unconfirmed;
    for (const row of r.unconfirmedRows ?? []) deps.log.warn(UNCONFIRMED_WARNING, { ledgerId: row.id, assignmentId: row.assignmentId, stage: row.stage, origin: "stale_sweep" });
  } catch (err) { deps.log.error("exception-alerts: falha ao soltar reservas antigas", (err as Error)?.name); }

  for (const org of enabled) {
    summary.organizations++;
    const settings = org.settings;
    const activatedAt = settings.exception_alerts_activated_at ? new Date(settings.exception_alerts_activated_at) : null;
    if (!activatedAt || Number.isNaN(activatedAt.getTime())) { deps.log.info("exception-alerts: sem exception_alerts_activated_at, nada será avisado", org.id); continue; }
    const calendar = resolveBusinessCalendar(settings.business_calendar);
    try {
      // Prontidão: sem destinatário administrativo válido e canal funcional, o modo "on" NÃO envia nem consome estágio.
      let readiness: AlertReadiness;
      try { readiness = evaluateAlertReadiness(await deps.readinessFacts(org.id)); }
      catch (err) { deps.log.error("exception-alerts: falha ao avaliar prontidão (nada enviado)", org.id, (err as Error)?.name); readiness = { ready: false, validManagerCount: 0, problems: ["no_recipients"] }; }
      if (settings.exception_alerts_mode === "on" && !readiness.ready) {
        summary.notReady++;
        deps.log.error("exception-alerts: modo on sem prontidão, nada enviado nem consumido", org.id, readiness.problems.join(","));
        continue;
      }
      const now = deps.now();
      const items = (await deps.loadItems(org.id, calendar, now)).filter(i => i.kind === "exception");
      if (!items.length) continue;
      const recorded = await deps.recordedSlots(items.map(i => i.assignment.id));
      const [managers, reps] = await Promise.all([deps.managerIds(org.id), deps.repUserIds(org.id)]);
      const managerSet = new Set(managers);
      const candidates = [...new Set([...managers, ...reps])];

      for (const item of items) {
        summary.evaluated++;
        const a = item.assignment;
        const mode = await deps.currentMode(org.id);
        if (mode === "off") { deps.log.info("exception-alerts: modo desligado durante o ciclo, interrompendo", org.id); break; }
        if (!candidates.length) { summary.noRecipients++; deps.log.info("exception-alerts: sem destinatário configurado (nada consumido)", org.id); continue; }
        const runMode: "shadow" | "on" = mode === "on" ? "on" : "shadow";
        const slots = recorded.get(a.id) ?? [];
        const messages = new Map<ExceptionAlertStage, ExceptionAlertMessage>();
        const messageFor = (stage: ExceptionAlertStage) => {
          let m = messages.get(stage);
          if (!m) {
            m = buildExceptionAlertMessage(stage, {
              anchorAt: a.handoff_at, accumulatedBusinessMinutes: item.triage.accumulatedBusinessMinutes,
              accumulatedWallMinutes: item.triage.accumulatedWallMinutes, timeZone: calendar.timeZone,
            });
            messages.set(stage, m);
          }
          return m;
        };

        for (const userId of candidates) {
          // Plano INDIVIDUAL: só conta o que já foi registrado para ESTE destinatário neste modo.
          const mine = slots.filter(s => s.recipientUserId === userId && countsForMode(runMode, s)).map(s => s.stage);
          const plan = planExceptionAlerts({
            mode, exceptionAt: new Date(a.assigned_at), now, calendar, recordedStages: mine,
            resolved: item.triage.state === "resolvida", activatedAt, eligibleStages: recipientEligibleStages(managerSet.has(userId)),
          });
          if (!plan.send) continue;
          const stage: ExceptionAlertStage = plan.send.stage;
          const message = messageFor(stage);
          const detail = {
            stage, severity: message.severity, accumulatedBusinessMinutes: item.triage.accumulatedBusinessMinutes,
            clientWaiting: item.triage.clientWaiting, ready: readiness.ready,
          };
          try {
            // Estágios mais baixos que ficaram para trás (para este destinatário): registrados, sem enxurrada de avisos atrasados.
            for (const s of plan.skip) {
              const skipped = await deps.claim({ organizationId: org.id, assignmentId: a.id, stage: s, channel: runMode === "on" ? "skipped" : "shadow", recipientUserId: userId, mode: runMode, detail: { reason: "superseded" } });
              if (skipped && runMode === "on") summary.skipped++;
            }
            if (runMode === "shadow") {
              const claimed = await deps.claim({ organizationId: org.id, assignmentId: a.id, stage, channel: "shadow", recipientUserId: userId, mode: "shadow", detail });
              if (claimed) summary.shadowed++;
              continue;
            }
            await sendOne(deps, summary, { organizationId: org.id, assignmentId: a.id, userId, stage, message, detail });
          } catch (err) {
            // Falha isolada de um destinatário não impede os demais nem o próximo ciclo.
            summary.failed++;
            deps.log.error("exception-alerts: falha ao tratar destinatário", org.id, (err as Error)?.name);
          }
        }
      }
    } catch (err) {
      deps.log.error("exception-alerts: falha no ciclo da organização", org.id, (err as Error)?.name);
    }
  }
  return summary;
}

/** Reserva -> marca "enviando" -> push -> confirma. Ver o cabeçalho do arquivo para a garantia contra duplicata. */
async function sendOne(
  deps: ExceptionAlertDeps, summary: ExceptionAlertSummary,
  x: { organizationId: string; assignmentId: string; userId: string; stage: ExceptionAlertStage; message: ExceptionAlertMessage; detail: Record<string, unknown> },
): Promise<void> {
  const claimed = await deps.claim({ organizationId: x.organizationId, assignmentId: x.assignmentId, stage: x.stage, channel: "push", recipientUserId: x.userId, mode: "on", detail: x.detail });
  if (!claimed) return; // outro processo já reservou este destinatário
  // Sem a marca "enviando" gravada, NÃO se chama o push (senão uma falha de banco depois do envio viraria reenvio).
  let marked = false;
  try { marked = await deps.markSending(claimed.id); } catch { marked = false; }
  if (!marked) { try { await deps.release(claimed.id); } catch { /* a reserva sem marca é solta pela varredura de reservas antigas */ } return; }

  let outcome: PushOutcome;
  // Exceção que escapa do envio não prova que nada saiu: tratada como resultado desconhecido (reserva preservada).
  try { outcome = await deps.sendPush(x.organizationId, x.userId, x.message, `exception-${x.assignmentId}-${x.stage}`); } catch { outcome = "unknown"; }

  if (outcome === "failed" || outcome === "unconfigured") {
    // Nada foi entregue: solta para a próxima varredura tentar de novo. Se a soltura falhar, a reserva marcada vira 'unconfirmed_send' (nunca duplica).
    try { await deps.release(claimed.id); } catch (err) { deps.log.error("exception-alerts: falha ao soltar reserva", x.organizationId, (err as Error)?.name); }
    return;
  }
  const status = outcome === "sent" ? "sent" : "skipped";
  const detail = outcome === "sent" ? x.detail : outcome === "unknown" ? { ...x.detail, reason: "unconfirmed_send", cause: "provider_result_unknown" } : { ...x.detail, reason: outcome };
  if (outcome === "unknown") deps.log.warn(UNCONFIRMED_WARNING, { ledgerId: claimed.id, assignmentId: x.assignmentId, stage: x.stage, origin: "send_result" });
  for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt++) {
    try {
      await deps.finish(claimed.id, status, detail);
      if (outcome === "sent") summary.sent++; else if (outcome === "unknown") summary.unconfirmed++; else summary.skipped++;
      return;
    } catch (err) {
      if (attempt === FINISH_ATTEMPTS) {
        // O push saiu, mas o banco não confirmou: a reserva fica marcada e NUNCA é reenviada.
        summary.unconfirmed++;
        deps.log.error("exception-alerts: resultado do push sem confirmação no livro, desconhecido ou entregue (não será reenviado)", x.organizationId, claimed.id, (err as Error)?.name);
        return;
      }
      await deps.sleep(200 * attempt);
    }
  }
}

export function defaultExceptionAlertDeps(overrides: Partial<ExceptionAlertDeps> = {}): ExceptionAlertDeps {
  const db = getAdminClient();
  return {
    now: () => new Date(),
    listOrganizations: async () => (await getAllOrganizations(db)) as Array<{ id: string; settings: Partial<OrganizationSettings> }>,
    currentMode: async id => { try { return ((await getOrganizationById(db, id)).settings.exception_alerts_mode ?? "off") as ExceptionAlertsMode; } catch { return "off"; } },
    loadItems: (orgId, calendar, now) => loadTriageItems(db, orgId, calendar, now),
    recordedSlots: ids => listRecordedAlertSlots(db, ids),
    managerIds: async orgId => {
      // Só quem está na lista explícita E ainda é membro com papel administrativo (owner/admin): vendedor na lista nunca recebe o crítico.
      const rows = await loadAlertReadinessRecipients(db, orgId);
      return rows.filter(r => r.memberRole === "owner" || r.memberRole === "admin").map(r => r.userId);
    },
    repUserIds: async orgId => {
      const reps = (await listSalesReps(db, orgId)).filter(r => r.availability !== "out");
      return [...(await listCurrentMemberIds(db, orgId, reps.map(r => r.user_id)))];
    },
    readinessFacts: async orgId => ({ pushConfigured: isPushConfigured(), recipients: await loadAlertReadinessRecipients(db, orgId) }),
    claim: c => claimAlertSlot(db, c),
    markSending: id => markAlertSending(db, id),
    finish: (id, status, detail) => finishAlertSlot(db, id, status, detail),
    release: id => releaseAlertSlot(db, id),
    releaseStale: () => releaseStaleAlertClaims(db, STALE_CLAIM_MS),
    sendPush: async (orgId, userId, message, tag) => {
      if (!isPushConfigured()) return "unconfigured";
      let r;
      // sendPushToUser só lança ao LER as assinaturas (antes de qualquer envio): evidência de que nada saiu.
      try { r = await sendPushToUser(db, userId, { title: message.title, body: message.body, url: message.url, tag }, { organizationId: orgId }); } catch { return "failed"; }
      return pushResultToOutcome(r);
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    log: console,
    ...overrides,
  };
}

/**
 * Timer simples no processo do worker (como o monitor da API): `busy` impede sobreposição local; o livro impede duplicata entre processos.
 * Desligamento total sem deploy de config: EXCEPTION_ALERTS_DISABLED=1 no ambiente do worker impede até criar o timer.
 */
export function startExceptionAlertsWorker(): NodeJS.Timeout | null {
  if (process.env.EXCEPTION_ALERTS_DISABLED === "1") { console.log("Exception-alerts worker desativado por EXCEPTION_ALERTS_DISABLED=1"); return null; }
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runExceptionAlertsOnce(defaultExceptionAlertDeps())
      .then(s => { if (s.sent || s.shadowed || s.skipped || s.released || s.unconfirmed || s.notReady || s.failed) console.log(`Exception alerts: ${s.sent} enviado(s), ${s.shadowed} em sombra, ${s.skipped} pulado(s), ${s.released} reserva(s) solta(s), ${s.unconfirmed} sem confirmação, ${s.notReady} org(s) sem prontidão, ${s.failed} falha(s)`); })
      .catch(err => console.error("Exception alerts tick failed:", (err as Error)?.name))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(tick, SWEEP_EVERY_MS);
  timer.unref();
  console.log("Exception-alerts worker started (every 60s; inert unless exception_alerts_mode is shadow/on)");
  return timer;
}
