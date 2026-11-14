import * as database from "@aula-agente/database";

// A lógica mora em @aula-agente/database (queries/waiting-on-sync.ts) para a API E o worker de envio compartilharem a mesma regra.
// Estes invólucros mantêm o contrato "nunca lança": a sincronização de waiting_on jamais pode derrubar a operação principal
// (conclusão de tarefa, webhook), nem mesmo por falha de importação.
type Args<K extends keyof typeof database> = Parameters<(typeof database)[K] extends (...a: infer A) => unknown ? (...a: A) => void : never>;

async function safe(name: string, run: () => Promise<string>): Promise<string> {
  try { return await run(); } catch (err) { console.error(`waiting_on sync (${name}) failed:`, (err as Error)?.message); return "error"; }
}

export const syncWaitingOnAfterHumanCompletion = (...a: Args<"syncWaitingOnAfterHumanCompletion">) => safe("task completed", () => database.syncWaitingOnAfterHumanCompletion(...a));
export const syncWaitingOnAfterCustomerReply = (...a: Args<"syncWaitingOnAfterCustomerReply">) => safe("customer reply", () => database.syncWaitingOnAfterCustomerReply(...a));
export const syncWaitingOnAfterSellerMessage = (...a: Args<"syncWaitingOnAfterSellerMessage">) => safe("seller message", () => database.syncWaitingOnAfterSellerMessage(...a));
