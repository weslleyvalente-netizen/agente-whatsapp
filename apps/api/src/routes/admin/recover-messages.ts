import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { evolutionWebhookPayloadSchema, resolveEvolutionPhone } from "@aula-agente/shared";
import {
  getAdminClient, getInstancesByOrganization, findExistingEvolutionMessageIds, getLastOutboundAtForPhone,
} from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { isManager } from "../../lib/lead-visibility.js";
import { probeRedis } from "../../lib/redis-probe.js";
import { REPLAY_TOKEN } from "../../lib/replay-token.js";
import { findStoredMessages, type EvolutionStoredMessage } from "../../services/evolution.service.js";
import { buildLidPhoneMap, applyLidMap } from "../../services/lid-phone-map.js";
import { isNonContentMessageType, isSystemJid, REPLAY_TIMESTAMP_HEADER, REPLAY_SAVE_ONLY_HEADER } from "../webhooks/evolution.js";

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
  skipped: { groups: number; nonContent: number; system: number };
  customersTotal: number;
  answeredCustomers: number;
  skippedAnswered: number;
  savedNoAiReply: number;
  groups: CustomerGroup[]; // só os que serão reenviados, por ordem da primeira mensagem
  answeredGroups: CustomerGroup[]; // já respondidos depois da mensagem perdida (a recuperação automática só os grava)
  failedInstances: string[]; // só com isolateInstances: instâncias cuja consulta à Evolution falhou
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
  summary: Omit<Analysis, "groups" | "answeredGroups" | "failedInstances"> & { toRecover: number; customers: number; note: string } | null;
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
  // Recuperação automática: uma instância com problema não impede as saudáveis (o botão manual continua falhando por inteiro).
  isolateInstances?: boolean;
}): Promise<Analysis> {
  const db = getAdminClient();
  const window = { gteSec: Math.floor(opts.sinceMs / 1000), lteSec: Math.ceil(opts.untilMs / 1000) };
  // Respostas nossas/humanas podem ter vindo depois do fim da janela.
  const sentWindow = { gteSec: window.gteSec, lteSec: Math.max(window.lteSec, Math.ceil(Date.now() / 1000)) };

  let fetched = 0;
  const skipped = { groups: 0, nonContent: 0, system: 0 };
  const seen = new Set<string>();
  const eligible: Candidate[] = [];
  const lastSentByJid = new Map<string, number>();

  // 1) Busca tudo, 2) monta o mapa lid -> telefone com TODOS os registros (recebidos e enviados), 3) processa.
  const fetchedByInstance: Array<{ instance: any; received: EvolutionStoredMessage[]; sent: EvolutionStoredMessage[] }> = [];
  const failedInstances: string[] = [];
  for (const instance of opts.instances) {
    try {
      const received = await findStoredMessages(instance.instance_name, window, false);
      const sent = await findStoredMessages(instance.instance_name, sentWindow, true);
      fetchedByInstance.push({ instance, received, sent });
    } catch (err) {
      if (!opts.isolateInstances) throw err;
      failedInstances.push(String(instance.instance_name)); // só o nome: o erro da Evolution pode ter URL/chave
    }
  }
  const ownPhones = new Set(opts.instances.map((i) => String(i.phone_number ?? "").replace(/\D/g, "")).filter((p) => p.length > 0));
  const lidMap = buildLidPhoneMap(
    fetchedByInstance.flatMap((f) => [...f.received, ...f.sent]).filter((r) => typeof r?.key?.remoteJid === "string"),
    { ownPhones }
  );

  for (const { instance, received, sent } of fetchedByInstance) {
    for (const raw of sent) {
      const rawJid = raw?.key?.remoteJid;
      if (typeof rawJid !== "string" || !raw.key.fromMe || rawJid.endsWith("@g.us") || isSystemJid(rawJid)) continue;
      const rec = applyLidMap(raw, lidMap, ownPhones);
      const jid = resolveEvolutionPhone(rec.key); // @lid -> número real via remoteJidAlt (ou mapa)
      const t = tsOf(rec);
      if (Number.isFinite(t)) { const k = `${instance.instance_id}|${jid}`; lastSentByJid.set(k, Math.max(lastSentByJid.get(k) ?? 0, t)); }
    }
    for (const raw of received) {
      fetched++;
      if (!raw?.key?.id || typeof raw.key.remoteJid !== "string" || raw.key.fromMe) continue;
      if (seen.has(raw.key.id)) continue;
      seen.add(raw.key.id);
      if (raw.key.remoteJid.endsWith("@g.us")) { skipped.groups++; continue; }
      if (isSystemJid(raw.key.remoteJid)) { skipped.system++; continue; }
      if (isNonContentMessageType(String(raw.messageType))) { skipped.nonContent++; continue; }
      eligible.push({ rec: applyLidMap(raw, lidMap, ownPhones), instanceId: instance.instance_id });
    }
  }

  const existing = await findExistingEvolutionMessageIds(db, eligible.map((c) => c.rec.key.id));
  const alreadyInCrm = eligible.filter((c) => existing.has(c.rec.key.id)).length;
  const candidates = eligible.filter((c) => !existing.has(c.rec.key.id)).sort((a, b) => tsOf(a.rec) - tsOf(b.rec));

  // Agrupa por instância + telefone: uma resposta dada por OUTRO número da empresa não conta como resposta aqui.
  const byJid = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${c.instanceId}|${resolveEvolutionPhone(c.rec.key)}`;
    const list = byJid.get(key);
    if (list) list.push(c); else byJid.set(key, [c]);
  }
  const all: CustomerGroup[] = [...byJid.entries()].map(([key, items]) => {
    const lastLost = tsOf(items[items.length - 1].rec);
    return { jid: resolveEvolutionPhone(items[0].rec.key), items, answered: (lastSentByJid.get(key) ?? 0) > lastLost };
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
    groups, answeredGroups: answered, failedInstances, sample,
  };
}

const publicSummary = (a: Analysis): NonNullable<RunStatus["summary"]> => {
  const { groups, answeredGroups, failedInstances, ...rest } = a;
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

// ---- Recuperação automática ----
// Rede de segurança contra o WhatsApp "conectado mas surdo": a cada ciclo, compara o que a Evolution guardou nas
// últimas horas com o CRM e reenvia ao webhook só o que faltou. Clientes já respondidos depois da mensagem perdida
// têm a mensagem gravada SEM acionar a IA (modo só gravar); os demais seguem o fluxo normal. Reaproveita a análise e o
// reenvio do botão manual e a mesma trava por organização.
export const RECONCILE_LOOKBACK_MS = 2 * 60 * 60 * 1000;
// Mensagens muito recentes ainda podem estar a caminho pelo webhook normal; deixa passar alguns minutos antes de buscar.
export const RECONCILE_GRACE_MS = 3 * 60 * 1000;
// Teto por ciclo (o que sobrar entra no próximo, pois continua ausente do CRM). Mutável para os testes.
export const reconcileLimits = { maxCustomers: 50, budgetMs: 4 * 60 * 1000 };

export interface ReconcileResult {
  skipped?: "running" | "no_instances" | "redis_down" | "error";
  customers: number;   // clientes reenviados à IA
  replayed: number;    // mensagens reenviadas à IA
  saved: number;       // mensagens só gravadas (cliente já respondido)
  failed: number;
  failedInstances: string[];
  truncated?: boolean; // parou no teto de clientes ou de tempo
  stopped?: boolean;   // a chave foi desligada durante o ciclo
}

export interface ReconcileOptions {
  now?: Date;
  /** Consultada antes de cada cliente; false interrompe o ciclo. */
  stillEnabled?: () => Promise<boolean>;
}

export async function reconcileRecentMessages(app: FastifyInstance, organizationId: string, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const empty = (skipped: ReconcileResult["skipped"], failedInstances: string[] = []): ReconcileResult =>
    ({ skipped, customers: 0, replayed: 0, saved: 0, failed: 0, failedInstances });
  if (running.has(organizationId)) return empty("running");
  let instances: any[];
  try {
    instances = (await getInstancesByOrganization(getAdminClient(), organizationId)).filter((i: any) => i.active_agent_id);
  } catch {
    return empty("error");
  }
  if (instances.length === 0) return empty("no_instances");
  // Sem Redis a IA não responde e o reenvio pendura.
  if (!(await probeRedis())) return empty("redis_down");
  // Sem await entre has() e add(): uma recuperação por organização por vez (compartilhada com o botão manual).
  if (running.has(organizationId)) return empty("running");
  running.add(organizationId);
  const startedAt = Date.now();
  try {
    const a = await analyze({
      organizationId, instances,
      sinceMs: now.getTime() - RECONCILE_LOOKBACK_MS, untilMs: now.getTime() - RECONCILE_GRACE_MS,
      includeAnswered: false, isolateInstances: true,
    });
    if (a.failedInstances.length === instances.length) return empty("error", a.failedInstances);
    const secret = process.env.WEBHOOK_SECRET;
    const result: ReconcileResult = { customers: 0, replayed: 0, saved: 0, failed: 0, failedInstances: a.failedInstances };
    // Quem precisa de resposta da IA primeiro; depois só gravar os já respondidos.
    const work = [
      ...a.groups.map((g) => ({ g, saveOnly: false })),
      ...a.answeredGroups.map((g) => ({ g, saveOnly: true })),
    ];
    let processed = 0;
    for (const { g, saveOnly } of work) {
      if (processed >= reconcileLimits.maxCustomers || Date.now() - startedAt > reconcileLimits.budgetMs) { result.truncated = true; break; }
      if (options.stillEnabled) {
        let on = false;
        try { on = await options.stillEnabled(); } catch { on = false; }
        if (!on) { result.stopped = true; break; }
      }
      if (processed > 0) await sleep(recoveryConfig.interMs);
      processed++;
      for (let i = 0; i < g.items.length; i++) {
        if (i > 0) await sleep(recoveryConfig.intraMs);
        const { rec, instanceId } = g.items[i];
        const outcome = await replayOne(app, rec, instanceId, secret, saveOnly);
        if (outcome === "replayed") { if (saveOnly) result.saved++; else result.replayed++; }
        else if (outcome === "failed") result.failed++;
      }
      if (!saveOnly) result.customers++;
    }
    return result;
  } catch {
    // O erro da Evolution pode conter URL/chave: nada dele sai daqui.
    return empty("error");
  } finally {
    running.delete(organizationId);
  }
}

async function replayOne(
  app: FastifyInstance, rec: EvolutionStoredMessage, instanceId: string, secret: string | undefined, saveOnly = false
): Promise<"replayed" | "duplicate" | "failed"> {
  const payload = {
    event: "messages.upsert",
    instance: instanceId,
    data: {
      key: {
        remoteJid: rec.key.remoteJid,
        ...(rec.key.remoteJidAlt ? { remoteJidAlt: rec.key.remoteJidAlt } : {}),
        fromMe: false,
        id: rec.key.id,
      },
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
        headers: { ...(secret ? { apikey: secret } : {}), [REPLAY_TIMESTAMP_HEADER]: REPLAY_TOKEN, ...(saveOnly ? { [REPLAY_SAVE_ONLY_HEADER]: REPLAY_TOKEN } : {}) },
        payload,
      }),
      timeout,
    ]);
    if (res.statusCode !== 200) return "failed";
    const reason = (res.json() as { skipped?: string }).skipped;
    if (!reason) return "replayed";
    if (reason === "duplicate") return "duplicate";
    if (reason === "human_takeover" || reason === "ai_disabled" || reason === "ignored_contact" || reason === "saved_only") return "replayed";
    return "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
