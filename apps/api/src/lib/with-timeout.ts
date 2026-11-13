export type TimedResult<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

/**
 * Executa `run` com um limite de tempo para a operação COMPLETA. Nunca lança: devolve ok, timeout ou error.
 * No timeout o sinal recebido é abortado (para a operação cancelar consultas em andamento) e qualquer resultado ou falha
 * tardia da operação é descartado sem gerar "unhandled rejection". O timer é sempre limpo.
 */
export async function runWithTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work: Promise<TimedResult<T>> = (async (): Promise<TimedResult<T>> => {
    try {
      return { status: "ok", value: await run(controller.signal) };
    } catch (error) {
      return { status: "error", error };
    }
  })();
  const timeout = new Promise<TimedResult<T>>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ status: "timeout" }); }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
