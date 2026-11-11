// Limite simples por organização+usuário, em memória (sem persistência): reinicia com o processo,
// o que basta para conter abuso de upload/armazenamento.
import { ATTACHMENT_LIMIT_PER_HOUR } from "@aula-agente/shared";

export { ATTACHMENT_LIMIT_PER_HOUR };
const WINDOW_MS = 60 * 60 * 1000;
const usage = new Map<string, number[]>();

/** Registra uma tentativa; false quando já usou o limite na última hora. */
export function takeAttachmentSlot(key: string, now = Date.now()): boolean {
  const recent = (usage.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= ATTACHMENT_LIMIT_PER_HOUR) {
    usage.set(key, recent);
    return false;
  }
  recent.push(now);
  usage.set(key, recent);
  return true;
}

/** Devolve a vaga de uma tentativa que não chegou a enviar nada. */
export function releaseAttachmentSlot(key: string) {
  const list = usage.get(key);
  if (list?.length) list.pop();
}

export function resetAttachmentLimitForTests() {
  usage.clear();
}
