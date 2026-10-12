import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  ADVANCED_FUNNEL_STAGES, CALL_OUTCOMES, CALL_STRATEGIES, buildCallReport, suggestCallStrategy,
  type CallLogRow, type CallReportOpportunity,
} from "@aula-agente/shared";
import { getAdminClient, getOpportunityById, listSalesReps } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { isManager } from "../../lib/lead-visibility.js";
import { canViewLead } from "../../lib/lead-access.js";

const callLogSchema = z.object({
  strategy: z.enum(CALL_STRATEGIES),
  outcome: z.enum(CALL_OUTCOMES),
  note: z.string().trim().max(2000).optional(),
});
const reportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const CHUNK = 200;
const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export default async function callLogRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  /** Membro da organização do negócio + permissão de ver o lead (isolamento por vendedor). */
  async function authorize(request: any, reply: any, opportunityId: string) {
    const db = getAdminClient();
    const opportunity = await getOpportunityById(db, opportunityId);
    const membership = request.user.memberships.find((m: any) => m.organization_id === opportunity.organization_id);
    if (!membership) { reply.status(403).send({ error: "Access denied" }); return null; }
    if (!(await canViewLead(db, opportunity.organization_id, membership.role, request.user.id, opportunity.owner_id))) {
      reply.status(403).send({ error: "Este lead pertence a outro vendedor" }); return null;
    }
    return { db, opportunity };
  }

  app.post<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/call-logs", async (request, reply) => {
    const parsed = callLogSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues });
    const ctx = await authorize(request, reply, request.params.opportunityId);
    if (!ctx) return;
    const { data, error } = await ctx.db.from("sales_call_logs").insert({
      organization_id: ctx.opportunity.organization_id,
      opportunity_id: ctx.opportunity.id,
      contact_id: ctx.opportunity.contact_id ?? null,
      rep_user_id: request.user.id,
      strategy: parsed.data.strategy,
      suggested_strategy: suggestCallStrategy(ctx.opportunity.id),
      outcome: parsed.data.outcome,
      note: parsed.data.note || null,
    }).select("*").single();
    if (error) throw error;
    return reply.status(201).send(data);
  });

  app.get<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/call-logs", async (request, reply) => {
    const ctx = await authorize(request, reply, request.params.opportunityId);
    if (!ctx) return;
    const { data, error } = await ctx.db.from("sales_call_logs").select("*")
      .eq("organization_id", ctx.opportunity.organization_id).eq("opportunity_id", ctx.opportunity.id)
      .order("called_at", { ascending: false });
    if (error) throw error;
    return { logs: data ?? [], suggestedStrategy: suggestCallStrategy(ctx.opportunity.id) };
  });

  app.get<{ Params: { organizationId: string }; Querystring: { from?: string; to?: string } }>(
    "/organizations/:organizationId/call-report", async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find(m => m.organization_id === organizationId);
      if (!membership || !isManager(membership.role)) return reply.status(403).send({ error: "Access denied" });
      const q = reportQuerySchema.safeParse(request.query);
      if (!q.success || q.data.from > q.data.to) return reply.status(400).send({ error: "Informe from e to (YYYY-MM-DD)" });

      const db = getAdminClient();
      // Dia civil de Brasília (UTC-3, sem horário de verão).
      const { data: rows, error } = await db.from("sales_call_logs").select("opportunity_id,rep_user_id,strategy,outcome")
        .eq("organization_id", organizationId)
        .gte("called_at", `${q.data.from}T00:00:00-03:00`).lt("called_at", `${nextDay(q.data.to)}T00:00:00-03:00`);
      if (error) throw error;
      const calls: CallLogRow[] = (rows ?? []).map((r: any) => ({ opportunityId: r.opportunity_id, repUserId: r.rep_user_id, strategy: r.strategy, outcome: r.outcome }));

      const ids = [...new Set(calls.map(c => c.opportunityId))];
      const opps: Record<string, CallReportOpportunity> = {};
      for (let i = 0; i < ids.length; i += CHUNK) {
        const part = ids.slice(i, i + CHUNK);
        const [{ data: os, error: e1 }, { data: evs, error: e2 }] = await Promise.all([
          db.from("opportunities").select("id,status,stage").eq("organization_id", organizationId).in("id", part),
          db.from("opportunity_events").select("opportunity_id,new_value").eq("organization_id", organizationId).eq("event_type", "stage_changed").in("opportunity_id", part),
        ]);
        if (e1) throw e1; if (e2) throw e2;
        const reached = new Set((evs ?? []).filter((e: any) => ADVANCED_FUNNEL_STAGES.includes(e.new_value?.stage)).map((e: any) => e.opportunity_id));
        for (const o of os ?? []) opps[(o as any).id] = { status: (o as any).status, stage: (o as any).stage, reachedAdvanced: reached.has((o as any).id) };
      }

      const names = new Map((await listSalesReps(db, organizationId)).map(r => [r.user_id, r.display_name]));
      const report = buildCallReport(calls, opps);
      return {
        from: q.data.from, to: q.data.to, byStrategy: report.byStrategy,
        byRep: report.byRep.map(r => ({ ...r, repName: names.get(r.repUserId) ?? null })),
        advancedStages: ADVANCED_FUNNEL_STAGES,
      };
    });
}
