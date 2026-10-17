import { getRedisConnection } from "@aula-agente/queue";

export const REDIS_PROBE_TIMEOUT_MS = 3000;

// Sonda de Redis sem vazar fila offline: se a conexão não está "ready" não chama ping
// (a conexão da fila usa maxRetriesPerRequest:null e enfileiraria o comando para sempre).
export async function probeRedis(timeoutMs = REDIS_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const conn = getRedisConnection();
    if (conn.status !== "ready") return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); });
    try {
      return (await Promise.race([conn.ping(), timeout])) === "PONG";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
