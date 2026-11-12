import type { FastifyInstance } from "fastify";
import { getAdminClient, getAllOrganizations, getOrganizationById } from "@aula-agente/database";
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
      // Relê a chave antes de cada cliente: desligar interrompe também um ciclo em andamento.
      const stillEnabled = async () => {
        try {
          const fresh = await getOrganizationById(getAdminClient(), org.id);
          return fresh.settings?.auto_recover_messages_enabled === true;
        } catch {
          return false;
        }
      };
      const r = await reconcileRecentMessages(app, org.id, { stillEnabled });
      const detail = { organizationId: org.id, customers: r.customers, replayed: r.replayed, saved: r.saved, failed: r.failed, failedInstances: r.failedInstances, truncated: r.truncated === true, stopped: r.stopped === true };
      if (r.skipped === "error" || r.failedInstances.length > 0) {
        log.error({ ...detail, skipped: r.skipped }, "auto-recover: ciclo com falha na consulta à Evolution");
      } else if (r.replayed > 0 || r.saved > 0 || r.failed > 0 || r.truncated || r.stopped) {
        log.info(detail, "auto-recover: mensagens perdidas reenviadas ao CRM");
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
