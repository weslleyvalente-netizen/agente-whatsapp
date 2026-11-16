import {
  buildExceptionAlertMessage, exceptionAlertRecipients, planExceptionAlerts, resolveBusinessCalendar,
  type BusinessCalendar, type ExceptionAlertMessage, type ExceptionAlertStage, type ExceptionAlertsMode, type OrganizationSettings,
} from "@aula-agente/shared";
import {
  claimAlertSlot, finishAlertSlot, getAdminClient, getAllOrganizations, getOrganizationById, listAlertRecipientIds, listRecordedAlertStages, listSalesReps,
  listCurrentMemberIds, loadTriageItems, releaseAlertSlot, releaseStaleAlertClaims, sendPushToUser, isPushConfigured,
  type AlertLedgerClaim, type TriageItem,
} from "@aula-agente/database";

// P0a: escada de alertas de exceção de SLA (0/15/30/60 min úteis). Nasce DESLIGADA: só roda para organizações com
// settings.exception_alerts_mode = "shadow" | "on" E settings.exception_alerts_activated_at preenchido (sem retroativo).
//  - shadow: calcula e REGISTRA no livro o que enviaria (canal "shadow"); não envia nada.
//  - on: reserva o slot no livro (índice único) e envia push. Falha de envio solta a reserva (nada foi entregue); "sem aparelho" é registrado.
// Idempotência/concorrência: o livro (exception_alert_ledger) tem índice único (exceção, estágio, canal, destinatário). Dois workers,
// reinício ou ciclo repetido nunca enviam duas vezes. Não escreve em lead_assignments nem toca o rodízio.

export const SWEEP_EVERY_MS = 60_000;
export const STALE_CLAIM_MS = 5 * 60_000;

type PushOutcome = "sent" | "no_device" | "unconfigured" | "failed";

export interface ExceptionAlertDeps {
  now(): Date;
  listOrganizations(): Promise<Array<{ id: string; settings: Partial<OrganizationSettings> }>>;
  /** Relê o modo a cada envio: desligar interrompe um ciclo em andamento. */
  currentMode(organizationId: string): Promise<ExceptionAlertsMode>;
  loadItems(organizationId: string, calendar: BusinessCalendar, now: Date): Promise<TriageItem[]>;
  recordedStages(assignmentIds: string[]): Promise<Map<string, number[]>>;
  managerIds(organizationId: string): Promise<string[]>;
  repUserIds(organizationId: string): Promise<string[]>;
  claim(c: AlertLedgerClaim): Promise<{ id: number } | null>;
  finish(id: number, status: "sent" | "skipped", detail?: Record<string, unknown>): Promise<void>;
  release(id: number): Promise<void>;
  releaseStale(): Promise<number>;
  sendPush(organizationId: string, userId: string, message: ExceptionAlertMessage, tag: string): Promise<PushOutcome>;
  log: { info(...a: unknown[]): void; error(...a: unknown[]): void };
}

export interface ExceptionAlertSummary { organizations: number; evaluated: number; sent: number; shadowed: number; skipped: number; noRecipients: number; released: number }

export async function runExceptionAlertsOnce(deps: ExceptionAlertDeps): Promise<ExceptionAlertSummary> {
  const summary: ExceptionAlertSummary = { organizations: 0, evaluated: 0, sent: 0, shadowed: 0, skipped: 0, noRecipients: 0, released: 0 };
  let orgs: Awaited<ReturnType<ExceptionAlertDeps["listOrganizations"]>>;
  try { orgs = await deps.listOrganizations(); } catch (err) { deps.log.error("exception-alerts: falha ao listar organizações", (err as Error)?.name); return summary; }
  const enabled = orgs.filter(o => o.settings.exception_alerts_mode === "shadow" || o.settings.exception_alerts_mode === "on");
  if (!enabled.length) return summary;
  try { summary.released = await deps.releaseStale(); } catch (err) { deps.log.error("exception-alerts: falha ao soltar reservas antigas", (err as Error)?.name); }

  for (const org of enabled) {
    summary.organizations++;
    const settings = org.settings;
    const activatedAt = settings.exception_alerts_activated_at ? new Date(settings.exception_alerts_activated_at) : null;
    if (!activatedAt || Number.isNaN(activatedAt.getTime())) { deps.log.info("exception-alerts: sem exception_alerts_activated_at, nada será avisado", org.id); continue; }
    const calendar = resolveBusinessCalendar(settings.business_calendar);
    try {
      const now = deps.now();
      const items = (await deps.loadItems(org.id, calendar, now)).filter(i => i.kind === "exception");
      if (!items.length) continue;
      const recorded = await deps.recordedStages(items.map(i => i.assignment.id));
      const [managers, reps] = await Promise.all([deps.managerIds(org.id), deps.repUserIds(org.id)]);

      for (const item of items) {
        summary.evaluated++;
        const a = item.assignment;
        const mode = await deps.currentMode(org.id);
        if (mode === "off") { deps.log.info("exception-alerts: modo desligado durante o ciclo, interrompendo", org.id); break; }
        const plan = planExceptionAlerts({
          mode, exceptionAt: new Date(a.assigned_at), now, calendar, recordedStages: recorded.get(a.id) ?? [],
          resolved: item.triage.state === "resolvida", activatedAt,
        });
        if (!plan.send) continue;
        const stage: ExceptionAlertStage = plan.send.stage;
        const recipients = exceptionAlertRecipients(stage, managers, reps);
        if (!recipients.length) { summary.noRecipients++; deps.log.info("exception-alerts: estágio vencido sem destinatário configurado (nada consumido)", org.id, stage); continue; }

        // Estágios mais baixos que ficaram para trás: registrados como pulados (sem enxurrada de avisos atrasados).
        for (const s of plan.skip) {
          const claimed = await deps.claim({ organizationId: org.id, assignmentId: a.id, stage: s, channel: "skipped", recipientUserId: null, mode: mode === "on" ? "on" : "shadow", detail: { reason: "superseded" } });
          if (claimed) summary.skipped++;
        }

        const message = buildExceptionAlertMessage(stage, {
          anchorAt: a.handoff_at, accumulatedBusinessMinutes: item.triage.accumulatedBusinessMinutes,
          accumulatedWallMinutes: item.triage.accumulatedWallMinutes, timeZone: calendar.timeZone,
        });
        const detail = { stage, severity: message.severity, accumulatedBusinessMinutes: item.triage.accumulatedBusinessMinutes, clientWaiting: item.triage.clientWaiting, recipients: recipients.length };

        for (const userId of recipients) {
          if (mode === "shadow") {
            const claimed = await deps.claim({ organizationId: org.id, assignmentId: a.id, stage, channel: "shadow", recipientUserId: userId, mode: "shadow", detail });
            if (claimed) summary.shadowed++;
            continue;
          }
          const claimed = await deps.claim({ organizationId: org.id, assignmentId: a.id, stage, channel: "push", recipientUserId: userId, mode: "on", detail });
          if (!claimed) continue; // outro processo já reservou este destinatário
          let outcome: PushOutcome;
          try { outcome = await deps.sendPush(org.id, userId, message, `exception-${a.id}-${stage}`); } catch { outcome = "failed"; }
          if (outcome === "sent") { await deps.finish(claimed.id, "sent", detail); summary.sent++; }
          else if (outcome === "failed" || outcome === "unconfigured") { await deps.release(claimed.id); }
          else { await deps.finish(claimed.id, "skipped", { ...detail, reason: outcome }); summary.skipped++; }
        }
      }
    } catch (err) {
      deps.log.error("exception-alerts: falha no ciclo da organização", org.id, (err as Error)?.name);
    }
  }
  return summary;
}

export function defaultExceptionAlertDeps(overrides: Partial<ExceptionAlertDeps> = {}): ExceptionAlertDeps {
  const db = getAdminClient();
  return {
    now: () => new Date(),
    listOrganizations: async () => (await getAllOrganizations(db)) as Array<{ id: string; settings: Partial<OrganizationSettings> }>,
    currentMode: async id => { try { return ((await getOrganizationById(db, id)).settings.exception_alerts_mode ?? "off") as ExceptionAlertsMode; } catch { return "off"; } },
    loadItems: (orgId, calendar, now) => loadTriageItems(db, orgId, calendar, now),
    recordedStages: ids => listRecordedAlertStages(db, ids),
    managerIds: async orgId => {
      const ids = await listAlertRecipientIds(db, orgId);
      // Só quem ainda é membro da organização (destinatário removido da equipe não recebe).
      return [...(await listCurrentMemberIds(db, orgId, ids))];
    },
    repUserIds: async orgId => {
      const reps = (await listSalesReps(db, orgId)).filter(r => r.availability !== "out");
      return [...(await listCurrentMemberIds(db, orgId, reps.map(r => r.user_id)))];
    },
    claim: c => claimAlertSlot(db, c),
    finish: (id, status, detail) => finishAlertSlot(db, id, status, detail),
    release: id => releaseAlertSlot(db, id),
    releaseStale: () => releaseStaleAlertClaims(db, STALE_CLAIM_MS),
    sendPush: async (orgId, userId, message, tag) => {
      if (!isPushConfigured()) return "unconfigured";
      const r = await sendPushToUser(db, userId, { title: message.title, body: message.body, url: message.url, tag }, { organizationId: orgId });
      if (r.skipped) return "unconfigured";
      if (r.sent > 0) return "sent";
      return r.failed > 0 ? "failed" : "no_device";
    },
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
      .then(s => { if (s.sent || s.shadowed || s.skipped || s.released) console.log(`Exception alerts: ${s.sent} enviado(s), ${s.shadowed} em sombra, ${s.skipped} pulado(s), ${s.released} reserva(s) solta(s)`); })
      .catch(err => console.error("Exception alerts tick failed:", (err as Error)?.name))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(tick, SWEEP_EVERY_MS);
  timer.unref();
  console.log("Exception-alerts worker started (every 60s; inert unless exception_alerts_mode is shadow/on)");
  return timer;
}
