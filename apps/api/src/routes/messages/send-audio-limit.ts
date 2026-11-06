// Limite simples por organização+usuário, em memória (sem persistência): reinicia com o processo,
// o que basta para conter abuso de upload/armazenamento.
export const SELLER_AUDIO_LIMIT_PER_HOUR = 30;
const WINDOW_MS = 60 * 60 * 1000;
const usage = new Map<string, number[]>();

/** Registra uma tentativa; false quando já usou o limite na última hora. */
export function takeSellerAudioSlot(key: string, now = Date.now()): boolean {
  const recent = (usage.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= SELLER_AUDIO_LIMIT_PER_HOUR) {
    usage.set(key, recent);
    return false;
  }
  recent.push(now);
  usage.set(key, recent);
  return true;
}

/** Devolve a vaga de uma tentativa que não chegou a enviar nada. */
export function releaseSellerAudioSlot(key: string) {
  const list = usage.get(key);
  if (list?.length) list.pop();
}

export function resetSellerAudioLimitForTests() {
  usage.clear();
}
