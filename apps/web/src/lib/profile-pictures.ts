export type FetchPictureBatch = (ids: string[]) => Promise<Record<string, string>>;

interface ResolverOptions {
  now?: () => number;
  ttlMs?: number;
  batchDelayMs?: number;
}

const MAX_BATCH = 100;

/**
 * Resolve links assinados de fotos de perfil: junta pedidos próximos, divide em lotes de até 100 ids
 * (limite da API), guarda em cache por `ttlMs` e compartilha a promessa de ids em voo.
 * Falha de rede => null só para os ids do lote, sem cache.
 */
export function createProfilePictureResolver(fetchBatch: FetchPictureBatch, opts: ResolverOptions = {}) {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 50 * 60 * 1000;
  const batchDelayMs = opts.batchDelayMs ?? 40;

  const cache = new Map<string, { url: string | null; expiresAt: number }>();
  const inflight = new Map<string, Promise<string | null>>();
  const resolvers = new Map<string, (url: string | null) => void>();
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function runChunk(ids: string[]) {
    let urls: Record<string, string> | null = null;
    try {
      urls = await fetchBatch(ids);
    } catch {
      urls = null;
    }
    const expiresAt = now() + ttlMs;
    for (const id of ids) {
      const url = urls ? (urls[id] ?? null) : null;
      if (urls) cache.set(id, { url, expiresAt });
      const resolve = resolvers.get(id);
      resolvers.delete(id);
      inflight.delete(id);
      resolve?.(url);
    }
  }

  function flush() {
    timer = null;
    const ids = pending;
    pending = [];
    for (let i = 0; i < ids.length; i += MAX_BATCH) void runChunk(ids.slice(i, i + MAX_BATCH));
  }

  function request(contactId: string): Promise<string | null> {
    const hit = cache.get(contactId);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.url);
    const existing = inflight.get(contactId);
    if (existing) return existing;
    const p = new Promise<string | null>((resolve) => {
      resolvers.set(contactId, resolve);
    });
    inflight.set(contactId, p);
    pending.push(contactId);
    if (!timer) timer = setTimeout(flush, batchDelayMs);
    return p;
  }

  return { request };
}
