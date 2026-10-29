/**
 * Cache em memória por organização com TTL curto e deduplicação de leituras simultâneas.
 * Guarda só dados brutos da organização (nunca o resultado filtrado por usuário) e nunca guarda erro.
 */
export function createOrgCache<T>(ttlMs: number) {
 const entries = new Map<string, { at: number; value: T }>();
 const pending = new Map<string, Promise<T>>();
 return {
  async get(organizationId: string, load: () => Promise<T>): Promise<T> {
   const hit = entries.get(organizationId);
   if (hit && Date.now() - hit.at < ttlMs) return hit.value;
   const running = pending.get(organizationId);
   if (running) return running;
   const promise = load().then(
    value => {
     // Se foi invalidada durante a leitura, o valor é entregue mas não fica guardado.
     if (pending.get(organizationId) === promise) { entries.set(organizationId, { at: Date.now(), value }); pending.delete(organizationId); }
     return value;
    },
    error => {
     if (pending.get(organizationId) === promise) pending.delete(organizationId);
     throw error;
    },
   );
   pending.set(organizationId, promise);
   return promise;
  },
  invalidate(organizationId: string) { entries.delete(organizationId); pending.delete(organizationId); },
  clear() { entries.clear(); pending.clear(); },
 };
}
