import { resolveEvolutionPhone } from "@aula-agente/shared";
import { findMessagesByRemoteJid } from "./evolution.service.js";

const PHONE_SUFFIX = "@s.whatsapp.net";

type LidKey = { remoteJid: string; remoteJidAlt?: string | null };
type Warn = (msg: string, ctx?: Record<string, unknown>) => void;

const digitsOf = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

/** Telefone real de uma key @lid com remoteJidAlt válido (e que não seja o da própria instância); null caso contrário. */
function realPhoneOf(key: LidKey, ownPhones?: ReadonlySet<string>): string | null {
  if (!key.remoteJid.endsWith("@lid")) return null;
  const phone = resolveEvolutionPhone(key);
  if (phone === key.remoteJid.replace(PHONE_SUFFIX, "")) return null;
  if (ownPhones?.has(phone)) return null;
  return phone;
}

/**
 * lid -> telefone a partir de TODOS os registros que trazem remoteJidAlt válido.
 * Se o mesmo lid aparecer com dois telefones diferentes, não é mapeado (aviso).
 */
export function buildLidPhoneMap(
  records: Array<{ key: LidKey }>,
  opts: { ownPhones?: ReadonlySet<string>; warn?: Warn } = {}
): Map<string, string> {
  const map = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const r of records) {
    const key = r?.key;
    if (!key || typeof key.remoteJid !== "string") continue;
    const phone = realPhoneOf(key, opts.ownPhones);
    if (!phone || conflicted.has(key.remoteJid)) continue;
    const prev = map.get(key.remoteJid);
    if (prev && prev !== phone) {
      map.delete(key.remoteJid);
      conflicted.add(key.remoteJid);
      (opts.warn ?? defaultWarn)("lid com telefones divergentes; não mapeado", { lidLast4: key.remoteJid.slice(-9, -4) });
      continue;
    }
    map.set(key.remoteJid, phone);
  }
  return map;
}

/**
 * Para registros @lid sem alt válido, devolve cópia com remoteJidAlt sintético do mapa.
 * Um alt igual ao número da própria instância é removido (nunca usado).
 */
export function applyLidMap<T extends { key: LidKey }>(rec: T, map: Map<string, string>, ownPhones?: ReadonlySet<string>): T {
  const key = rec.key;
  if (!key.remoteJid.endsWith("@lid") || realPhoneOf(key, ownPhones)) return rec;
  const phone = map.get(key.remoteJid);
  const { remoteJidAlt: oldAlt, ...rest } = key;
  if (phone) return { ...rec, key: { ...rest, remoteJidAlt: `${phone}${PHONE_SUFFIX}` } };
  if (oldAlt && ownPhones?.has(resolveEvolutionPhone(key))) return { ...rec, key: rest };
  return rec;
}

const defaultWarn: Warn = (msg, ctx) => console.warn(`[lid-map] ${msg}`, ctx ?? {});

export interface LidResolverOptions {
  fetchRecords: (instanceName: string, lid: string, signal?: AbortSignal) => Promise<Array<{ key: LidKey }>>;
  ttlMs?: number;
  negativeTtlMs?: number;
  maxSize?: number;
  timeoutMs?: number;
  now?: () => number;
  warn?: Warn;
}

/**
 * Cache em memória (instância + lid) -> telefone, com consulta ao Evolution quando a mensagem chega sem remoteJidAlt.
 * Nunca lança: qualquer falha/timeout resulta no comportamento antigo (remoteJid inalterado).
 */
export function createLidPhoneResolver(opts: LidResolverOptions) {
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const negativeTtlMs = opts.negativeTtlMs ?? 60_000;
  const maxSize = opts.maxSize ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? defaultWarn;

  const cache = new Map<string, { phone: string; expires: number }>();
  const misses = new Map<string, number>(); // chave -> até quando não consultar de novo
  const conflicts = new Map<string, number>(); // chave -> até quando não mapear (telefones divergentes)
  const inflight = new Map<string, Promise<string | undefined>>();
  const keyOf = (instanceName: string, lid: string) => `${instanceName}|${lid}`;

  function trim<V>(m: Map<string, V>) {
    while (m.size > maxSize) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  function get(instanceName: string, lid: string): string | undefined {
    const k = keyOf(instanceName, lid);
    const hit = cache.get(k);
    if (!hit) return undefined;
    if (hit.expires <= now()) { cache.delete(k); return undefined; }
    return hit.phone;
  }

  function set(k: string, phone: string): void {
    if ((conflicts.get(k) ?? 0) > now()) return;
    const prev = cache.get(k);
    if (prev && prev.expires > now() && prev.phone !== phone) {
      cache.delete(k);
      conflicts.set(k, now() + ttlMs);
      trim(conflicts);
      warn("lid com telefones divergentes; removido do cache", { lidLast4: k.slice(-9, -4) });
      return;
    }
    cache.delete(k); // reinsere: mais antigo primeiro
    cache.set(k, { phone, expires: now() + ttlMs });
    misses.delete(k);
    trim(cache);
  }

  function remember(key: LidKey, instanceName: string, ownPhone?: string | null) {
    const own = digitsOf(ownPhone);
    const phone = realPhoneOf(key, own ? new Set([own]) : undefined);
    if (phone) set(keyOf(instanceName, key.remoteJid), phone);
  }

  async function lookup(instanceName: string, lid: string, own: ReadonlySet<string> | undefined): Promise<string | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); });
      const records = await Promise.race([opts.fetchRecords(instanceName, lid, signal), timeout]);
      return buildLidPhoneMap(records, { ownPhones: own, warn }).get(lid);
    } catch (err) {
      warn("falha ao consultar o Evolution; seguindo sem mapa", { errName: (err as Error)?.name, message: (err as Error)?.message });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolve(key: LidKey, instanceName: string, ownPhone?: string | null): Promise<string> {
    const direct = resolveEvolutionPhone(key);
    if (!key.remoteJid.endsWith("@lid")) return direct;
    const ownDigits = digitsOf(ownPhone);
    const own = ownDigits ? new Set([ownDigits]) : undefined;
    const lid = key.remoteJid;
    const fallback = realPhoneOf(key, own) ? direct : lid; // alt da própria instância não vale
    if (realPhoneOf(key, own)) { remember(key, instanceName, ownPhone); return direct; }

    const k = keyOf(instanceName, lid);
    const cached = get(instanceName, lid);
    if (cached) return cached;
    if ((conflicts.get(k) ?? 0) > now()) return fallback;
    if ((misses.get(k) ?? 0) > now()) return fallback;

    let pending = inflight.get(k);
    if (!pending) {
      pending = lookup(instanceName, lid, own).finally(() => { inflight.delete(k); });
      inflight.set(k, pending);
    }
    const phone = await pending;
    if (phone) { set(k, phone); return get(instanceName, lid) ?? fallback; }
    // Uma mensagem com alt pode ter alimentado o cache enquanto a consulta corria.
    const late = get(instanceName, lid);
    if (late) return late;
    misses.set(k, now() + negativeTtlMs);
    trim(misses);
    return fallback;
  }

  function reset() { cache.clear(); misses.clear(); conflicts.clear(); inflight.clear(); }

  return { resolve, remember, get, size: () => cache.size, reset };
}

export const lidPhoneResolver = createLidPhoneResolver({
  fetchRecords: (instanceName, lid, signal) => findMessagesByRemoteJid(instanceName, lid, 20, signal),
});
