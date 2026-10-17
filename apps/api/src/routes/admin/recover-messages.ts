import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { evolutionWebhookPayloadSchema } from "@aula-agente/shared";
import { getAdminClient, getInstancesByOrganization, messageExistsByEvolutionId } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { isManager } from "../../lib/lead-visibility.js";
import { findReceivedMessages, type EvolutionStoredMessage } from "../../services/evolution.service.js";
import { isNonContentMessageType, REPLAY_TIMESTAMP_HEADER } from "../webhooks/evolution.js";

// Intervalo entre mensagens reenviadas (para não sobrecarregar a fila/IA). Mutável para os testes.
export const recoveryConfig = { delayMs: 1500 };

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 20;

const bodySchema = z.object({
  since: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }).optional(),
  dryRun: z.boolean().default(true),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const last4 = (jid: string) => jid.replace(/\D/g, "").slice(-4);
const tsOf = (r: EvolutionStoredMessage) => Number(r.messageTimestamp);

// Uma recuperação por organização por vez (reenvio é lento e a IA responde a cada cliente).
const running = new Set<string>();

type Candidate = { rec: EvolutionStoredMessage; instanceId: string };

export default async function recoverMessagesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { organizationId: string } }>("/organizations/:organizationId/admin/recover-messages", async (request, reply) => {
    const { organizationId } = request.params;
    if (!z.string().uuid().safeParse(organizationId).success) return reply.status(400).send({ error: "organizationId inválido" });

    const role = request.user.memberships.find((m) => m.organization_id === organizationId)?.role;
    if (!role || !isManager(role)) return reply.status(403).send({ error: "Somente owner/admin podem recuperar mensagens" });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) });
    const { dryRun } = parsed.data;
    const sinceMs = Date.parse(parsed.data.since);
    const untilMs = parsed.data.until ? Date.parse(parsed.data.until) : Date.now();
    if (!(untilMs > sinceMs)) return reply.status(400).send({ error: "until deve ser depois de since" });
    if (untilMs - sinceMs > MAX_WINDOW_MS) return reply.status(400).send({ error: "A janela máxima é de 7 dias" });

    if (running.has(organizationId)) return reply.status(409).send({ error: "Já existe uma recuperação em andamento para esta organização" });
    running.add(organizationId);
    try {
      const db = getAdminClient();
      let instances;
      try {
        instances = (await getInstancesByOrganization(db, organizationId)).filter((i: any) => i.active_agent_id);
      } catch (err) {
        request.log.error({ err, organizationId }, "recover-messages: failed to load instances");
        return reply.status(500).send({ error: "Erro ao carregar as instâncias" });
      }
      if (instances.length === 0) return reply.status(409).send({ error: "Nenhuma instância com agente ativo nesta organização" });

      const window = { gteSec: Math.floor(sinceMs / 1000), lteSec: Math.ceil(untilMs / 1000) };
      let fetched = 0;
      let alreadyInCrm = 0;
      const skipped = { groups: 0, nonContent: 0 };
      const candidates: Candidate[] = [];
      const seen = new Set<string>();

      for (const instance of instances as any[]) {
        let records: EvolutionStoredMessage[];
        try {
          records = await findReceivedMessages(instance.instance_name, window);
        } catch (err) {
          // O erro da Evolution pode conter a URL/corpo; registra só a classe e devolve mensagem genérica.
          request.log.error({ organizationId, errName: (err as Error)?.name }, "recover-messages: Evolution findMessages failed");
          return reply.status(502).send({ error: "Falha ao consultar a Evolution API" });
        }
        for (const rec of records) {
          fetched++;
          if (!rec?.key?.id || typeof rec.key.remoteJid !== "string" || rec.key.fromMe) continue;
          if (seen.has(rec.key.id)) continue;
          seen.add(rec.key.id);
          if (rec.key.remoteJid.endsWith("@g.us")) { skipped.groups++; continue; }
          if (isNonContentMessageType(String(rec.messageType))) { skipped.nonContent++; continue; }
          if (await messageExistsByEvolutionId(db, rec.key.id)) { alreadyInCrm++; continue; }
          candidates.push({ rec, instanceId: instance.instance_id });
        }
      }

      candidates.sort((a, b) => tsOf(a.rec) - tsOf(b.rec));

      const perCustomer = new Map<string, { phoneLast4: string; firstAt: number; lastAt: number; count: number }>();
      for (const { rec } of candidates) {
        const jid = rec.key.remoteJid;
        const t = tsOf(rec);
        const entry = perCustomer.get(jid);
        if (entry) { entry.count++; entry.firstAt = Math.min(entry.firstAt, t); entry.lastAt = Math.max(entry.lastAt, t); }
        else perCustomer.set(jid, { phoneLast4: last4(jid), firstAt: t, lastAt: t, count: 1 });
      }
      const iso = (sec: number) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
      const sample = [...perCustomer.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, SAMPLE_LIMIT)
        .map((c) => ({ phoneLast4: c.phoneLast4, firstAt: iso(c.firstAt), lastAt: iso(c.lastAt), count: c.count }));

      let replayed = 0;
      let failed = 0;
      if (!dryRun) {
        const secret = process.env.WEBHOOK_SECRET;
        for (let i = 0; i < candidates.length; i++) {
          const { rec, instanceId } = candidates[i];
          if (i > 0 && recoveryConfig.delayMs > 0) await sleep(recoveryConfig.delayMs);
          const payload = {
            event: "messages.upsert",
            instance: instanceId,
            data: {
              key: { remoteJid: rec.key.remoteJid, fromMe: false, id: rec.key.id },
              pushName: rec.pushName ?? null,
              message: rec.message ?? null,
              messageType: rec.messageType,
              messageTimestamp: tsOf(rec),
              contextInfo: rec.contextInfo ?? null,
            },
          };
          if (!evolutionWebhookPayloadSchema.safeParse(payload).success) { failed++; continue; }
          try {
            const res = await app.inject({
              method: "POST",
              url: "/webhooks/evolution",
              headers: { ...(secret ? { apikey: secret } : {}), [REPLAY_TIMESTAMP_HEADER]: "1" },
              payload,
            });
            if (res.statusCode !== 200) { failed++; continue; }
            const skippedReason = (res.json() as { skipped?: string }).skipped;
            if (!skippedReason) replayed++;
            else if (skippedReason === "duplicate") alreadyInCrm++;
            else if (skippedReason === "human_takeover" || skippedReason === "ai_disabled" || skippedReason === "ignored_contact") replayed++;
            else failed++;
          } catch (err) {
            request.log.error({ organizationId, errName: (err as Error)?.name }, "recover-messages: replay failed for one message");
            failed++;
          }
        }
      }

      request.log.info({ organizationId, dryRun, fetched, toRecover: candidates.length, replayed, failed }, "recover-messages finished");
      return {
        dryRun,
        instance: (instances as any[]).map((i) => i.instance_name).join(", "),
        fetched,
        alreadyInCrm,
        toRecover: candidates.length,
        customers: perCustomer.size,
        replayed,
        failed,
        skipped,
        sample,
      };
    } finally {
      running.delete(organizationId);
    }
  });
}
