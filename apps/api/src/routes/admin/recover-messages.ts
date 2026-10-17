import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { evolutionWebhookPayloadSchema } from "@aula-agente/shared";
import {
  getAdminClient, getInstancesByOrganization, findExistingEvolutionMessageIds, getLastOutboundAtForPhone,
} from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { isManager } from "../../lib/lead-visibility.js";
import { probeRedis } from "../../lib/redis-probe.js";
import { REPLAY_TOKEN } from "../../lib/replay-token.js";
import { findStoredMessages, type EvolutionStoredMessage } from "../../services/evolution.service.js";
import { isNonContentMessageType, REPLAY_TIMESTAMP_HEADER } from "../webhooks/evolution.js";

// Tempos do reenvio. Mutável para os testes.
//  - intraMs: entre mensagens do MESMO cliente (a fila agrupa em ~6 s e a IA responde uma vez só);
//  - interMs: entre clientes, para não sobrecarregar a fila/IA;
//  - injectTimeoutMs: teto para uma mensagem (um inject pendurado conta como falha).
export const recoveryConfig = { intraMs: 150, interMs: 1500, injectTimeoutMs: 30_000 };

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 20;

const bodySchema = z.object({
  since: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }).optional(),
  dryRun: z.boolean().default(true),
  // Padrão false: clientes que já receberam resposta (telefone/humano ou IA) depois da última mensagem perdida NÃO são reenviados.
  includeAnswered: z.boolean().default(false),
});

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
const last4 = (jid: string) => jid.replace(/\D/g, "").slice(-4);
const tsOf = (r: EvolutionStoredMessage) => Number(r.messageTimestamp);
const phoneOf = (jid: string) => jid.replace("@s.whatsapp.net", "");
const iso = (sec: number) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);

type Candidate = { rec: EvolutionStoredMessage; instanceId: string };
interface CustomerGroup { jid: string; items: Candidate[]; answered: boolean }

interface Analysis {
  instance: string;
  fetched: number;
  alreadyInCrm: number;
  skipped: { groups: number; nonContent: number };
  customersTotal: number;
  answeredCustomers: number;
  skippedAnswered: number;
  savedNoAiReply: number;
  groups: CustomerGroup[]; // só os que serão reenviados, por ordem da primeira mensagem
  sample: Array<{ phoneLast4: string; firstAt: string | null; lastAt: string | null; count: number }>;
}

export interface RunStatus {
  runId: string;
  state: "running" | "done" | "failed";
  total: number;
  done: number;
  replayed: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  summary: Omit<Analysis, "groups"> & { toRecover: number; customers: number; note: string } | null;
}

// Uma recuperação por organização por vez; o estado da última fica em memória.
const running = new Set<string>();
const statuses = new Map<string, RunStatus>();
// Para os testes: espera as execuções em segundo plano terminarem.
export async function waitForRecoveryIdle() { while (running.size > 0) await new Promise((r) => setTimeout(r, 2)); }
export function resetRecoveryState() { running.clear(); statuses.clear(); }

function buildNote(a: { savedNoAiReply: number; answeredCustomers: number; skippedAnswered: number }): string {
  const parts: string[] = [];
  if (a.answeredCustomers > 0) {
    parts.push(`${a.answeredCustomers} cliente(s) já foram respondidos depois da última mensagem perdida (${a.skippedAnswered} mensagem(ns) não reenviada(s), para a IA não responder de novo).`);
  }
  if (a.savedNoAiReply > 0) {
    parts.push(`${a.savedNoAiReply} mensagem(ns) serão salvas com o horário original, mas sem resposta nova da IA, porque já existe uma resposta nossa mais recente na conversa.`);
  }
  return parts.join(" ");
}

async function analyze(opts: {
  organizationId: string; instances: any[]; sinceMs: number; untilMs: number; includeAnswered: boolean;
}): Promise<Analysis> {
  const db = getAdminClient();
  const window = { gteSec: Math.floor(opts.sinceMs / 1000), lteSec: Math.ceil(opts.untilMs / 1000) };
  // Respostas nossas/humanas podem ter vindo depois do fim da janela.
  const sentWindow = { gteSec: window.gteSec, lteSec: Math.max(window.lteSec, Math.ceil(Date.now() / 1000)) };

  let fetched = 0;
  const skipped = { groups: 0, nonContent: 0 };
  const seen = new Set<string>();
  const eligible: Candidate[] = [];
  const lastSentByJid = new Map<string, number>();

  for (const instance of opts.instances) {
    const received = await findStoredMessages(instance.instance_name, window, false);
    const sent = await findStoredMessages(instance.instance_name, sentWindow, true);
    for (const rec of sent) {
      const jid = rec?.key?.remoteJid;
      if (typeof jid !== "string" || !rec.key.fromMe || jid.endsWith("@g.us")) continue;
      const t = tsOf(rec);
      if (Number.isFinite(t)) lastSentByJid.set(jid, Math.max(lastSentByJid.get(jid) ?? 0, t));
    }
    for (const rec of received) {
      fetched++;
      if (!rec?.key?.id || typeof rec.key.remoteJid !== "string" || rec.key.fromMe) continue;
      if (seen.has(rec.key.id)) continue;
      seen.add(rec.key.id);
      if (rec.key.remoteJid.endsWith("@g.us")) { skipped.groups++; continue; }
      if (isNonContentMessageType(String(rec.messageType))) { skipped.nonContent++; continue; }
      eligible.push({ rec, instanceId: instance.instance_id });
    }
  }

  const existing = await findExistingEvolutionMessageIds(db, eligible.map((c) => c.rec.key.id));
  const alreadyInCrm = eligible.filter((c) => existing.has(c.rec.key.id)).length;
  const candidates = eligible.filter((c) => !existing.has(c.rec.key.id)).sort((a, b) => tsOf(a.rec) - tsOf(b.rec));

  const byJid = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byJid.get(c.rec.key.remoteJid);
    if (list) list.push(c); else byJid.set(c.rec.key.remoteJid, [c]);
  }
  const all: CustomerGroup[] = [...byJid.entries()].map(([jid, items]) => {
    const lastLost = tsOf(items[items.length - 1].rec);
    return { jid, items, answered: (lastSentByJid.get(jid) ?? 0) > lastLost };
  }).sort((a, b) => tsOf(a.items[0].rec) - tsOf(b.items[0].rec));

  const answered = all.filter((g) => g.answered);
  const groups = opts.includeAnswered ? all : all.filter((g) => !g.answered);
  const skippedAnswered = opts.includeAnswered ? 0 : answered.reduce((n, g) => n + g.items.length, 0);

  // Mensagens que ficarão ANTES de uma resposta nossa já existente: a IA não as considera pendentes.
  let savedNoAiReply = 0;
  for (const g of groups) {
    try {
      const lastOutbound = await getLastOutboundAtForPhone(db, opts.organizationId, phoneOf(g.jid));
      if (!lastOutbound) continue;
      const cutoff = Date.parse(lastOutbound);
      savedNoAiReply += g.items.filter((c) => tsOf(c.rec) * 1000 < cutoff).length;
    } catch {
      // Estimativa: falha de consulta não impede a recuperação.
    }
  }

  const sample = groups
    .map((g) => ({ phoneLast4: last4(g.jid), firstAt: iso(tsOf(g.items[0].rec)), lastAt: iso(tsOf(g.items[g.items.length - 1].rec)), count: g.items.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, SAMPLE_LIMIT);

  return {
    instance: opts.instances.map((i) => i.instance_name).join(", "),
    fetched, alreadyInCrm, skipped,
    customersTotal: all.length, answeredCustomers: answered.length, skippedAnswered, savedNoAiReply,
    groups, sample,
  };
}

const publicSummary = (a: Analysis): NonNullable<RunStatus["summary"]> => {
  const { groups, ...rest } = a;
  const toRecover = groups.reduce((n, g) => n + g.items.length, 0);
  return { ...rest, toRecover, customers: groups.length, note: buildNote(a) };
};

export default async function recoverMessagesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  const authorize = (request: any, reply: any, organizationId: string): boolean => {
    if (!z.string().uuid().safeParse(organizationId).success) { reply.status(400).send({ error: "organizationId inválido" }); return false; }
    const role = request.user.memberships.find((m: any) => m.organization_id === organizationId)?.role;
    if (!role || !isManager(role)) { reply.status(403).send({ error: "Somente owner/admin podem recuperar mensagens" }); return false; }
    return true;
  };

  app.get<{ Params: { organizationId: string } }>("/organizations/:organizationId/admin/recover-messages/status", async (request, reply) => {
    if (!authorize(request, reply, request.params.organizationId)) return;
    return statuses.get(request.params.organizationId) ?? { state: "idle" };
  });

  app.post<{ Params: { organizationId: string } }>("/organizations/:organizationId/admin/recover-messages", async (request, reply) => {
    const { organizationId } = request.params;
    if (!authorize(request, reply, organizationId)) return;

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) });
    const { dryRun, includeAnswered } = parsed.data;
    const sinceMs = Date.parse(parsed.data.since);
    const untilMs = parsed.data.until ? Date.parse(parsed.data.until) : Date.now();
    if (!(untilMs > sinceMs)) return reply.status(400).send({ error: "until deve ser depois de since" });
    if (untilMs - sinceMs > MAX_WINDOW_MS) return reply.status(400).send({ error: "A janela máxima é de 7 dias" });

    if (!dryRun && running.has(organizationId)) return reply.status(409).send({ error: "Já existe uma recuperação em andamento para esta organização" });

    let instances: any[];
    try {
      instances = (await getInstancesByOrganization(getAdminClient(), organizationId)).filter((i: any) => i.active_agent_id);
    } catch (err) {
      request.log.error({ organizationId, errName: (err as Error)?.name }, "recover-messages: failed to load instances");
      return reply.status(500).send({ error: "Erro ao carregar as instâncias" });
    }
    if (instances.length === 0) return reply.status(409).send({ error: "Nenhuma instância com agente ativo nesta organização" });

    if (dryRun) {
      try {
        const a = await analyze({ organizationId, instances, sinceMs, untilMs, includeAnswered });
        const s = publicSummary(a);
        return { dryRun: true, replayed: 0, failed: 0, ...s, sample: a.sample };
      } catch (err) {
        // O erro da Evolution pode conter URL/corpo; registra só a classe.
        request.log.error({ organizationId, errName: (err as Error)?.name }, "recover-messages: analysis failed");
        return reply.status(502).send({ error: "Falha ao consultar a Evolution API" });
      }
    }

    // Reenvio real: sem Redis a IA não responde e o inject pendura. Recusa antes de começar.
    if (!(await probeRedis())) return reply.status(503).send({ error: "Redis indisponível: a recuperação não pode começar agora" });
    // Checagem síncrona entre o probe e o add: não há await entre has() e add().
    if (running.has(organizationId)) return reply.status(409).send({ error: "Já existe uma recuperação em andamento para esta organização" });
    running.add(organizationId);

    const status: RunStatus = {
      runId: randomUUID(), state: "running", total: 0, done: 0, replayed: 0, failed: 0,
      startedAt: new Date().toISOString(), finishedAt: null, summary: null,
    };
    statuses.set(organizationId, status);
    const log = request.log;

    void (async () => {
      try {
        const a = await analyze({ organizationId, instances, sinceMs, untilMs, includeAnswered });
        status.summary = publicSummary(a);
        status.total = status.summary.toRecover;
        const secret = process.env.WEBHOOK_SECRET;

        for (let gi = 0; gi < a.groups.length; gi++) {
          if (gi > 0) await sleep(recoveryConfig.interMs);
          const items = a.groups[gi].items;
          for (let i = 0; i < items.length; i++) {
            if (i > 0) await sleep(recoveryConfig.intraMs);
            const { rec, instanceId } = items[i];
            const outcome = await replayOne(app, rec, instanceId, secret);
            status.done++;
            if (outcome === "replayed") status.replayed++;
            else if (outcome === "duplicate") status.summary.alreadyInCrm++;
            else status.failed++;
          }
        }
        status.state = "done";
      } catch (err) {
        log.error({ organizationId, errName: (err as Error)?.name }, "recover-messages: run failed");
        status.state = "failed";
      } finally {
        status.finishedAt = new Date().toISOString();
        running.delete(organizationId);
        log.info({ organizationId, state: status.state, total: status.total, replayed: status.replayed, failed: status.failed }, "recover-messages finished");
      }
    })();

    return reply.status(202).send({ runId: status.runId });
  });
}

async function replayOne(
  app: FastifyInstance, rec: EvolutionStoredMessage, instanceId: string, secret: string | undefined
): Promise<"replayed" | "duplicate" | "failed"> {
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
  if (!evolutionWebhookPayloadSchema.safeParse(payload).success) return "failed";
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), recoveryConfig.injectTimeoutMs); });
    const res = await Promise.race([
      app.inject({
        method: "POST", url: "/webhooks/evolution",
        headers: { ...(secret ? { apikey: secret } : {}), [REPLAY_TIMESTAMP_HEADER]: REPLAY_TOKEN },
        payload,
      }),
      timeout,
    ]);
    if (res.statusCode !== 200) return "failed";
    const reason = (res.json() as { skipped?: string }).skipped;
    if (!reason) return "replayed";
    if (reason === "duplicate") return "duplicate";
    if (reason === "human_takeover" || reason === "ai_disabled" || reason === "ignored_contact") return "replayed";
    return "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
