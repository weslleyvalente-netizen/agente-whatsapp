import { getRedisConnection } from "@aula-agente/queue";

export const REDIS_PROBE_TIMEOUT_MS = 3000;

type Conn = ReturnType<typeof getRedisConnection>;

// Logo após o boot da API (ex.: um deploy) a conexão ainda está abrindo: "connecting" não é "fora do ar".
// Espera ficar "ready" até o limite; só então conclui que não está. Já "end"/"close" (sem tentativa em curso) é falha na hora.
function waitUntilReady(conn: Conn, timeoutMs: number): Promise<boolean> {
  if (conn.status === "ready") return Promise.resolve(true);
  if (!["wait", "connecting", "connect", "reconnecting"].includes(conn.status)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean) => { clearTimeout(timer); conn.off("ready", onReady); resolve(ok); };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    conn.once("ready", onReady);
  });
}

// Sonda de Redis sem vazar fila offline: se a conexão não ficar "ready" no tempo, não chama ping
// (a conexão da fila usa maxRetriesPerRequest:null e enfileiraria o comando para sempre).
export async function probeRedis(timeoutMs = REDIS_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const conn = getRedisConnection();
    const started = Date.now();
    if (!(await waitUntilReady(conn, timeoutMs))) return false;
    const remaining = Math.max(timeoutMs - (Date.now() - started), 500);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), remaining); });
    try {
      return (await Promise.race([conn.ping(), timeout])) === "PONG";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
