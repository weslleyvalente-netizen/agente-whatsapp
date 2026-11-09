export type FetchPictureBatch = (ids: string[]) => Promise<Record<string, string>>;

interface ResolverOptions {
  now?: () => number;
  ttlMs?: number;
  batchDelayMs?: number;
}

interface Waiter {
  resolve: (url: string | null) => void;
}

/**
 * Resolve links assinados de fotos de perfil: junta pedidos próximos em uma única chamada,
 * guarda em cache por `ttlMs` e não repete ids em voo. Falha de rede => null, sem cache.
 */
export function createProfilePictureResolver(fetchBatch: FetchPictureBatch, opts: ResolverOptions = {}) {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 50 * 60 * 1000;
  const batchDelayMs = opts.batchDelayMs ?? 40;

  const cache = new Map<string, { url: string | null; expiresAt: number }>();
  const waiters = new Map<string, Waiter[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    timer = null;
    const batch = new Map(waiters);
    waiters.clear();
    const ids = [...batch.keys()];
    if (ids.length === 0) return;
    let urls: Record<string, string> | null = null;
    try {
      urls = await fetchBatch(ids);
    } catch {
      urls = null;
    }
    const expiresAt = now() + ttlMs;
    for (const [id, list] of batch) {
      const url = urls ? (urls[id] ?? null) : null;
      if (urls) cache.set(id, { url, expiresAt });
      for (const w of list) w.resolve(url);
    }
  }

  function request(contactId: string): Promise<string | null> {
    const hit = cache.get(contactId);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.url);
    return new Promise((resolve) => {
      const list = waiters.get(contactId);
      if (list) list.push({ resolve });
      else waiters.set(contactId, [{ resolve }]);
      if (!timer) timer = setTimeout(() => void flush(), batchDelayMs);
    });
  }

  return { request };
}
