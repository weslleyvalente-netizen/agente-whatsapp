import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  checkNoActionClosure, contactDisplayName, evaluateAlertReadiness, EXCEPTION_EVENT_KINDS, funnelConversationHref, NO_ACTION_WAITING_JUSTIFICATIONS, resolveBusinessCalendar,
} from "@aula-agente/shared";
import { getAdminClient, getOrganizationById, isPushConfigured, loadAlertReadinessRecipients, loadTriageItems, recordExceptionEvent } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { isManager } from "../../lib/lead-visibility.js";

// P0a: painel de triagem de exceções (urgentes / respondidas / obsoletas) e reconhecimento/resolução auditáveis.
// Tudo atrás de settings.exception_triage_panel_enabled (ausente = desligado: a rota devolve { enabled: false } e o painel antigo segue).
// Só gestores. Não altera dono, rodízio nem lead_assignments: "resolver" grava um evento append-only.
const uuid = z.string().uuid();
const bodySchema = z.object({
  kind: z.enum(EXCEPTION_EVENT_KINDS),
  note: z.string().trim().max(500).optional(),
  repId: uuid.optional(),
  // Obrigatória (lista fechada) para encerrar "sem ação" enquanto o cliente ainda aguarda.
  waitingJustification: z.enum(NO_ACTION_WAITING_JUSTIFICATIONS).optional(),
});

export default async function exceptionTriageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);
  const roleIn = (request: any, organizationId: string): string | null =>
    request.user.memberships.find((m: any) => m.organization_id === organizationId)?.role ?? null;

  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/exception-triage", async (request, reply) => {
    const { organizationId } = request.params;
    if (!uuid.safeParse(organizationId).success) return reply.status(400).send({ error: "Organização inválida" });
    const role = roleIn(request, organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores veem a triagem de exceções" });
    const db = getAdminClient();
    const org = await getOrganizationById(db, organizationId);
    if (org.settings.exception_triage_panel_enabled !== true) return { enabled: false };
    const calendar = resolveBusinessCalendar(org.settings.business_calendar);
    const items = await loadTriageItems(db, organizationId, calendar, new Date());
    const rows = items.filter(i => i.triage.group !== null).map(i => ({
      id: i.assignment.id,
      kind: i.kind,
      conversationId: i.assignment.conversation_id,
      href: funnelConversationHref(i.assignment.conversation_id),
      client: contactDisplayName(i.contact?.name, i.contact?.phone),
      chainReps: i.chainReps,
      exceptionReason: i.assignment.exception_reason ?? null,
      state: i.triage.state,
      group: i.triage.group,
      clientWaiting: i.triage.clientWaiting,
      waitingSince: i.triage.waitingSince,
      hasCommercialReply: i.triage.hasCommercialReply,
      lastReplyClass: i.triage.lastReplyClass,
      needsOwnerConfirmation: i.triage.needsOwnerConfirmation,
      handoffAt: i.assignment.handoff_at,
      flaggedAt: i.kind === "exception" ? i.assignment.assigned_at : i.assignment.sla_due_at,
      accumulatedBusinessMinutes: i.triage.accumulatedBusinessMinutes,
      accumulatedWallMinutes: i.triage.accumulatedWallMinutes,
      events: i.events.map(e => ({ kind: e.kind, at: e.created_at, repId: e.rep_id, note: e.note })),
    }));
    const by = (g: string) => rows.filter(r => r.group === g);
    const alertsMode = org.settings.exception_alerts_mode ?? "off";
    // Prontidão (só leitura): destinatário administrativo válido + aparelho push + push configurado. null = não foi possível verificar.
    let readiness: ReturnType<typeof evaluateAlertReadiness> | null = null;
    if (alertsMode !== "off") {
      try { readiness = evaluateAlertReadiness({ pushConfigured: isPushConfigured(), recipients: await loadAlertReadinessRecipients(db, organizationId) }); }
      catch { readiness = null; }
    }
    return {
      enabled: true,
      alertsMode,
      readiness,
      urgent: by("urgente"), answered: by("respondida"), obsolete: by("obsoleta"),
    };
  });

  app.post<{ Params: { organizationId: string; assignmentId: string } }>("/organizations/:organizationId/exception-events/:assignmentId", async (request, reply) => {
    const { organizationId, assignmentId } = request.params;
    if (!uuid.safeParse(organizationId).success || !uuid.safeParse(assignmentId).success) return reply.status(400).send({ error: "Identificador inválido" });
    const role = roleIn(request, organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores reconhecem ou resolvem exceções" });
    const body = bodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues });
    const db = getAdminClient();
    const org = await getOrganizationById(db, organizationId);
    if (org.settings.exception_triage_panel_enabled !== true) return reply.status(404).send({ error: "Recurso desativado" });
    let note = body.data.note ?? null;
    if (body.data.kind === "resolved_no_action") {
      // Regra de segurança: não encerra "sem ação" com cliente aguardando sem justificativa da lista fechada + nota de 20+ caracteres.
      // O estado é relido agora (não confia no que a tela mostrava), para pegar o cliente que escreveu depois do carregamento.
      const calendar = resolveBusinessCalendar(org.settings.business_calendar);
      const current = (await loadTriageItems(db, organizationId, calendar, new Date())).find(i => i.assignment.id === assignmentId);
      const check = checkNoActionClosure({ clientWaiting: current?.triage.clientWaiting === true, justification: body.data.waitingJustification, note });
      if (!check.ok) return reply.status(409).send({ error: check.message, code: check.code });
      note = check.note;
    }
    try {
      const id = await recordExceptionEvent(db, { organizationId, assignmentId, kind: body.data.kind, actorUserId: request.user.id, note, repId: body.data.repId ?? null });
      return { id };
    } catch (err) {
      const message = (err as { message?: string }).message ?? "Não foi possível registrar";
      return reply.status(/já foi resolvida|encerrada/.test(message) ? 409 : 400).send({ error: message });
    }
  });
}
