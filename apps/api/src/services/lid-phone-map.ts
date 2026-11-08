import { resolveEvolutionPhone } from "@aula-agente/shared";
import { findMessagesByRemoteJid, type EvolutionStoredMessage } from "./evolution.service.js";

const PHONE_SUFFIX = "@s.whatsapp.net";

type LidKey = { remoteJid: string; remoteJidAlt?: string | null };

/** Telefone real de uma key @lid com remoteJidAlt válido; null caso contrário. */
function realPhoneOf(key: LidKey): string | null {
  if (!key.remoteJid.endsWith("@lid")) return null;
  const phone = resolveEvolutionPhone(key);
  return phone === key.remoteJid.replace(PHONE_SUFFIX, "") ? null : phone;
}

/** lid -> telefone a partir de TODOS os registros que trazem remoteJidAlt válido. */
export function buildLidPhoneMap(records: Array<{ key: LidKey }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) {
    const key = r?.key;
    if (!key || typeof key.remoteJid !== "string") continue;
    const phone = realPhoneOf(key);
    if (phone) map.set(key.remoteJid, phone);
  }
  return map;
}

/** Para registros @lid sem alt válido cujo lid está no mapa, devolve cópia com remoteJidAlt sintético. */
export function applyLidMap<T extends { key: LidKey }>(rec: T, map: Map<string, string>): T {
  const key = rec.key;
  if (!key.remoteJid.endsWith("@lid") || realPhoneOf(key)) return rec;
  const phone = map.get(key.remoteJid);
  if (!phone) return rec;
  return { ...rec, key: { ...key, remoteJidAlt: `${phone}${PHONE_SUFFIX}` } };
}

export interface LidResolverOptions {
  fetchRecords: (instanceName: string, lid: string) => Promise<Array<{ key: LidKey }>>;
  ttlMs?: number;
  negativeTtlMs?: number;
  maxSize?: number;
  timeoutMs?: number;
  now?: () => number;
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Cache em memória lid -> telefone com consulta ao Evolution quando a mensagem chega sem remoteJidAlt.
 * Nunca lança: qualquer falha/timeout resulta no comportamento antigo (remoteJid inalterado).
 */
export function createLidPhoneResolver(opts: LidResolverOptions) {
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const negativeTtlMs = opts.negativeTtlMs ?? 60_000;
  const maxSize = opts.maxSize ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((msg, ctx) => console.warn(`[lid-map] ${msg}`, ctx ?? {}));

  const cache = new Map<string, { phone: string; expires: number }>();
  const misses = new Map<string, number>(); // lid -> até quando não consultar de novo

  function set(lid: string, phone: string) {
    cache.delete(lid); // reinsere para manter a ordem de inserção (mais antigo primeiro)
    cache.set(lid, { phone, expires: now() + ttlMs });
    misses.delete(lid);
    while (cache.size > maxSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function get(lid: string): string | undefined {
    const hit = cache.get(lid);
    if (!hit) return undefined;
    if (hit.expires <= now()) { cache.delete(lid); return undefined; }
    return hit.phone;
  }

  function remember(key: LidKey) {
    const phone = realPhoneOf(key);
    if (phone) set(key.remoteJid, phone);
  }

  async function lookup(instanceName: string, lid: string): Promise<string | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); });
      const records = await Promise.race([opts.fetchRecords(instanceName, lid), timeout]);
      return buildLidPhoneMap(records).get(lid);
    } catch (err) {
      warn("falha ao consultar o Evolution; seguindo sem mapa", { errName: (err as Error)?.name, message: (err as Error)?.message });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolve(key: LidKey, instanceName: string): Promise<string> {
    const direct = resolveEvolutionPhone(key);
    if (!key.remoteJid.endsWith("@lid")) return direct;
    if (realPhoneOf(key)) { remember(key); return direct; }

    const lid = key.remoteJid;
    const cached = get(lid);
    if (cached) return cached;
    if ((misses.get(lid) ?? 0) > now()) return direct;

    const phone = await lookup(instanceName, lid);
    if (phone) { set(lid, phone); return phone; }
    misses.set(lid, now() + negativeTtlMs);
    if (misses.size > maxSize) {
      const oldest = misses.keys().next().value;
      if (oldest !== undefined) misses.delete(oldest);
    }
    return direct;
  }

  return { resolve, remember, get, size: () => cache.size };
}

export const lidPhoneResolver = createLidPhoneResolver({
  fetchRecords: (instanceName, lid) => findMessagesByRemoteJid(instanceName, lid, 20),
});

export type { EvolutionStoredMessage };
