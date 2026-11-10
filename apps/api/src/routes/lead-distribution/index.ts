import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  contactDisplayName, formatElapsed, funnelConversationHref, SALES_REP_AVAILABILITIES, SLA_NUDGE_COOLDOWN_MINUTES, type LeadAssignment, type SlaAlert,
} from "@aula-agente/shared";
import {
  acceptAssignment, claimPushDedupe, computeSlaDueAt, getAdminClient, getAssignmentForNudge, getLastNudgeAt, getOrganizationById, getSalesRepByUser,
  isPushConfigured, listAssignmentsForContact, listContactsByIds, listOpenExceptions, listSalesReps, listSlaAlerts, manualAssignLead,
  recordNudge, releasePushDedupe, sendPushToUser, setRepAvailability,
} from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { isManager, isSellerFilterEnabled, resolveLeadVisibility } from "../../lib/lead-visibility.js";

const uuid = z.string().uuid();

/** Junta nome e telefone do cliente aos alertas com UMA busca em lote (nome nulo se o contato não existir). */
async function withContacts(db: ReturnType<typeof getAdminClient>, organizationId: string, alerts: LeadAssignment[]): Promise<SlaAlert[]> {
  if (!alerts.length) return [];
  const contacts = new Map((await listContactsByIds(db, organizationId, alerts.map((a) => a.contact_id))).map((c) => [c.id, c]));
  return alerts.map((a) => ({ ...a, contact_name: contacts.get(a.contact_id)?.name ?? null, contact_phone: contacts.get(a.contact_id)?.phone ?? null }));
}

type NudgeOutcome = { status: "sent" | "no_device" | "failed" | "rate_limited" | "busy"; delivered?: number; retryAfterMinutes?: number };

/**
 * Envia um toque com o limite de 2 h. Uma trava curta (`nudge-lock:<prefixo>`, insert atômico via claimPushDedupe, liberada no finally)
 * cobre "ler último toque -> enviar -> gravar", então dois pedidos simultâneos não enviam duas vezes; o limite continua medido
 * exatamente a partir do último toque real (getLastNudgeAt). Sem aparelho ou com falha de envio nada é gravado (não consome o limite).
 * Falha ao gravar o toque DEPOIS de enviado não vira erro: o aviso já saiu.
 */
async function deliverNudge(
  db: ReturnType<typeof getAdminClient>, log: { warn: (o: object, m: string) => void },
  p: { prefix: string; userId: string; organizationId: string; now: Date; payload: { title: string; body: string; url: string; tag: string } },
): Promise<NudgeOutcome> {
  const lockKey = `nudge-lock:${p.prefix}`;
  if (!(await claimPushDedupe(db, lockKey, p.userId))) return { status: "busy", retryAfterMinutes: 1 };
  try {
    const wait = cooldownMinutesLeft(await getLastNudgeAt(db, p.prefix), p.now);
    if (wait > 0) return { status: "rate_limited", retryAfterMinutes: wait };
    const result = await sendPushToUser(db, p.userId, p.payload, { organizationId: p.organizationId });
    if (result.sent === 0) return { status: result.failed > 0 ? "failed" : "no_device", delivered: 0 };
    try { await recordNudge(db, p.prefix, p.userId, p.now); }
    catch (err) { log.warn({ err, prefix: p.prefix }, "Nudge sent but recording it failed; the 2 h limit will not apply to this toque"); }
    return { status: "sent", delivered: result.sent };
  } finally {
    await releasePushDedupe(db, [lockKey]).catch((err) => log.warn({ err, lockKey }, "Failed to release nudge lock"));
  }
}

/** Minutos que faltam para o próximo toque (0 = liberado). */
function cooldownMinutesLeft(last: Date | null, now: Date): number {
  if (!last) return 0;
  const left = last.getTime() + SLA_NUDGE_COOLDOWN_MINUTES * 60_000 - now.getTime();
  return left > 0 ? Math.ceil(left / 60_000) : 0;
}

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
    if (!uuid.safeParse(organizationId).success || !uuid.safeParse(repId).success) return reply.status(400).send({ error: "id inválido" });
    const role = roleIn(request, organizationId);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    const body = z.object({ availability: z.enum(SALES_REP_AVAILABILITIES) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues });
    const db = getAdminClient();
    if (!isManager(role)) {
      const own = await getSalesRepByUser(db, organizationId, request.user.id);
      if (!own || own.id !== repId) return reply.status(403).send({ error: "Você só pode alterar a sua própria disponibilidade" });
    }
    try {
      return await setRepAvailability(db, { organizationId, repId, availability: body.data.availability });
    } catch (err) {
      // .single() sem linha (vendedor inexistente nesta organização) → PGRST116.
      if ((err as { code?: string }).code === "PGRST116") return reply.status(404).send({ error: "Vendedor não encontrado" });
      request.log.error({ err, organizationId, repId }, "Failed to update sales rep availability");
      return reply.status(500).send({ error: "Erro ao alterar a disponibilidade" });
    }
  });

  app.post<{ Params: { id: string }; Querystring: { organizationId?: string } }>("/lead-assignments/:id/accept", async (request, reply) => {
    if (!uuid.safeParse(request.params.id).success) return reply.status(400).send({ error: "id inválido" });
    // O parâmetro organizationId é ignorado para autorização: vale a organização real da atribuição.
    const db = getAdminClient();
    const { data: found, error: findError } = await db.from("lead_assignments").select("organization_id").eq("id", request.params.id).maybeSingle();
    if (findError) return reply.status(500).send({ error: "Erro ao buscar a atribuição" });
    if (!found) return reply.status(404).send({ error: "Atribuição não encontrada" });
    const role = roleIn(request, found.organization_id);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    try {
      const accepted = await acceptAssignment(db, { assignmentId: request.params.id, actorUserId: request.user.id, actorIsAdmin: isManager(role) });
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

  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/lead-assignments/sla-alerts", async (request, reply) => {
    const role = roleIn(request, request.params.organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores veem os alertas de SLA" });
    const db = getAdminClient();
    return withContacts(db, request.params.organizationId, await listSlaAlerts(db, request.params.organizationId));
  });

  // Cutucar: push ao vendedor dono do cliente que está esperando. Limite de 2 h por atribuição, registrado em push_notification_log
  // (chave `nudge:<atribuição>:<instante>`); nenhum toque falhado/sem aparelho conta. Ver deliverNudge.
  app.post<{ Params: { organizationId: string; assignmentId: string } }>("/organizations/:organizationId/lead-assignments/:assignmentId/nudge", async (request, reply) => {
    const { organizationId, assignmentId } = request.params;
    if (!uuid.safeParse(organizationId).success || !uuid.safeParse(assignmentId).success) return reply.status(400).send({ error: "id inválido" });
    const role = roleIn(request, organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores cutucam vendedores" });
    const db = getAdminClient();
    const a = await getAssignmentForNudge(db, organizationId, assignmentId);
    if (!a) return reply.status(404).send({ error: "Atribuição não encontrada" });
    if (a.status !== "pending" || a.sla_action !== "alert" || !a.sla_breached) return reply.status(409).send({ error: "Este alerta não está mais pendente" });
    const reps = await listSalesReps(db, organizationId);
    const rep = reps.find((r) => r.id === a.rep_id);
    if (!rep?.user_id) return reply.status(409).send({ error: "Este vendedor não tem usuário vinculado; não dá para enviar o aviso" });
    if (!isPushConfigured()) return reply.status(503).send({ error: "Notificações não configuradas no servidor" });
    const now = new Date();
    const prefix = `nudge:${assignmentId}:`;
    const [contact] = await listContactsByIds(db, organizationId, [a.contact_id]);
    const client = contactDisplayName(contact?.name, contact?.phone);
    const since = Date.parse(a.sla_due_at ?? a.assigned_at);
    try {
      const out = await deliverNudge(db, request.log, {
        prefix, userId: rep.user_id, organizationId, now, payload: {
          title: "Cliente esperando resposta",
          body: `${rep.display_name}, responda ${client}: prazo vencido há ${formatElapsed(now.getTime() - since)}`,
          url: funnelConversationHref(a.conversation_id), tag: `nudge-${assignmentId}`,
        },
      });
      if (out.status === "rate_limited" || out.status === "busy") {
        return reply.status(429).send({ error: out.status === "busy" ? "Já tem um aviso sendo enviado para este cliente. Tente de novo em instantes" : `Este cliente já foi cutucado. Tente de novo em ${out.retryAfterMinutes} min`, retryAfterMinutes: out.retryAfterMinutes });
      }
      if (out.status === "sent") return { status: "sent", delivered: out.delivered, nudgedAt: now.toISOString() };
      return { status: out.status, delivered: 0 };
    } catch (err) {
      request.log.error({ err, organizationId, assignmentId }, "Failed to nudge sales rep");
      return reply.status(500).send({ error: "Erro ao enviar o aviso" });
    }
  });

  // Cutucar todos: UM aviso por vendedor com os clientes dele em atraso. Limite de 2 h por vendedor (`nudge-rep:<vendedor>:`),
  // independente do limite por atribuição.
  app.post<{ Params: { organizationId: string } }>("/organizations/:organizationId/lead-assignments/nudge-all", async (request, reply) => {
    const { organizationId } = request.params;
    if (!uuid.safeParse(organizationId).success) return reply.status(400).send({ error: "id inválido" });
    const role = roleIn(request, organizationId);
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente gestores cutucam vendedores" });
    if (!isPushConfigured()) return reply.status(503).send({ error: "Notificações não configuradas no servidor" });
    const db = getAdminClient();
    const alerts = await withContacts(db, organizationId, await listSlaAlerts(db, organizationId));
    const reps = await listSalesReps(db, organizationId);
    const byRep = new Map<string, SlaAlert[]>();
    for (const a of alerts) if (a.rep_id) byRep.set(a.rep_id, [...(byRep.get(a.rep_id) ?? []), a]);
    const now = new Date();
    const results: Array<{ repId: string; repName: string; count: number; status: "sent" | "rate_limited" | "no_device" | "failed" | "no_user"; retryAfterMinutes?: number }> = [];
    for (const [repId, list] of byRep) {
      const rep = reps.find((r) => r.id === repId);
      const base = { repId, repName: rep?.display_name ?? "—", count: list.length };
      if (!rep?.user_id) { results.push({ ...base, status: "no_user" }); continue; }
      const prefix = `nudge-rep:${repId}:`;
      const names = list.slice(0, 3).map((a) => contactDisplayName(a.contact_name, a.contact_phone));
      const more = list.length > 3 ? ` e mais ${list.length - 3}` : "";
      const head = list.length === 1 ? "1 cliente esperando resposta" : `${list.length} clientes esperando resposta`;
      try {
        const out = await deliverNudge(db, request.log, {
          prefix, userId: rep.user_id, organizationId, now, payload: {
            title: "Cliente esperando resposta", body: `${rep.display_name}, ${head}: ${names.join(", ")}${more}`,
            url: "/opportunities", tag: `nudge-rep-${repId}`,
          },
        });
        if (out.status === "rate_limited" || out.status === "busy") results.push({ ...base, status: "rate_limited", retryAfterMinutes: out.retryAfterMinutes });
        else results.push({ ...base, status: out.status });
      } catch (err) {
        request.log.error({ err, organizationId, repId }, "Failed to nudge sales rep");
        return reply.status(500).send({ error: "Erro ao enviar os avisos", results });
      }
    }
    return { results, nudgedAt: now.toISOString() };
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
    if (!uuid.safeParse(organizationId).success || !uuid.safeParse(contactId).success) return reply.status(400).send({ error: "id inválido" });
    const role = roleIn(request, organizationId);
    if (!role) return reply.status(403).send({ error: "Access denied" });
    const db = getAdminClient();
    const org = await getOrganizationById(db, organizationId);
    const history = await listAssignmentsForContact(db, organizationId, contactId);
    const visibility = resolveLeadVisibility({ role, userId: request.user.id, leadDistributionEnabled: isSellerFilterEnabled(org.settings) });
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
