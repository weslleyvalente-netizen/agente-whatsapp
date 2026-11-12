import type { FastifyInstance } from "fastify";
import { getAdminClient, getAllOrganizations } from "@aula-agente/database";
import { reconcileRecentMessages } from "../routes/admin/recover-messages.js";

// Recuperação automática de mensagens perdidas. Roda no processo da API (setInterval), como o alerta de silêncio.
// Cada organização só entra com settings.auto_recover_messages_enabled === true (desligada por padrão).

export const AUTO_RECOVER_INTERVAL_MS = 5 * 60 * 1000;

interface AutoRecoverLog { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void }

export async function runAutoRecoverOnce(app: FastifyInstance, log: AutoRecoverLog): Promise<void> {
  let orgs: Array<{ id: string; settings: { auto_recover_messages_enabled?: boolean } }>;
  try {
    orgs = (await getAllOrganizations(getAdminClient())) as typeof orgs;
  } catch (err) {
    log.error({ errName: (err as Error)?.name }, "auto-recover: failed to list organizations");
    return;
  }
  for (const org of orgs) {
    if (org.settings?.auto_recover_messages_enabled !== true) continue;
    try {
      const r = await reconcileRecentMessages(app, org.id);
      if (r.replayed > 0 || r.failed > 0) {
        log.info({ organizationId: org.id, customers: r.customers, replayed: r.replayed, failed: r.failed }, "auto-recover: mensagens perdidas reenviadas ao CRM");
      }
    } catch (err) {
      log.error({ organizationId: org.id, errName: (err as Error)?.name }, "auto-recover: run failed");
    }
  }
}

export function startAutoRecover(app: FastifyInstance, log: AutoRecoverLog = console): NodeJS.Timeout {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runAutoRecoverOnce(app, log).catch((err) => log.error({ errName: (err as Error)?.name }, "auto-recover: tick failed")).finally(() => { busy = false; });
  };
  // Primeira passada 60 s após o boot, depois a cada 5 min.
  setTimeout(tick, 60_000).unref();
  const timer = setInterval(tick, AUTO_RECOVER_INTERVAL_MS);
  timer.unref();
  return timer;
}
