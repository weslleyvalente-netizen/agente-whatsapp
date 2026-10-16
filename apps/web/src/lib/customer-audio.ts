// Referência estável gravada em messages.media_url pelo worker (ver CUSTOMER_AUDIO_REF_PREFIX em @aula-agente/shared).
// Mantida local para o bundle do navegador não depender de nada além do prefixo.
export function hasStoredAudio(message: { media_type: string | null; media_url: string | null }): boolean {
  return message.media_type === "audio" && typeof message.media_url === "string" && message.media_url.startsWith("storage:");
}

export function formatAudioDuration(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
