// Lógica pura do gravador de áudio do vendedor (testável sem DOM).
// Constantes espelham SELLER_AUDIO_MAX_SECONDS / SELLER_AUDIO_MIN_SECONDS de
// @aula-agente/shared (packages/shared/src/seller-audio.ts); mantidas locais
// para o bundle do navegador, como em customer-audio.ts.
export const SELLER_AUDIO_MAX_SECONDS = 300;
export const SELLER_AUDIO_MIN_SECONDS = 1;

const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

export function pickRecorderMimeType(isSupported: (t: string) => boolean): string | null {
  for (const t of CANDIDATE_MIME_TYPES) {
    if (isSupported(t)) return t;
  }
  return null;
}

export type RecState = { phase: "idle" | "recording" | "review" | "sending"; seconds: number };

export type RecAction =
  | { type: "start" }
  | { type: "tick" }
  | { type: "stop" }
  | { type: "discard" }
  | { type: "send" }
  | { type: "sent" }
  | { type: "failed" };

export function recorderReducer(state: RecState, action: RecAction): RecState {
  switch (action.type) {
    case "start":
      return state.phase === "idle" ? { phase: "recording", seconds: 0 } : state;
    case "tick":
      if (state.phase !== "recording") return state;
      if (state.seconds >= SELLER_AUDIO_MAX_SECONDS) return { phase: "review", seconds: state.seconds };
      return { phase: "recording", seconds: state.seconds + 1 };
    case "stop":
      if (state.phase !== "recording") return state;
      if (state.seconds < SELLER_AUDIO_MIN_SECONDS) return { phase: "idle", seconds: 0 };
      return { phase: "review", seconds: state.seconds };
    case "discard":
      return state.phase === "review" || state.phase === "recording" ? { phase: "idle", seconds: 0 } : state;
    case "send":
      return state.phase === "review" ? { phase: "sending", seconds: state.seconds } : state;
    case "sent":
      return state.phase === "sending" ? { phase: "idle", seconds: 0 } : state;
    case "failed":
      return state.phase === "sending" ? { phase: "review", seconds: state.seconds } : state;
  }
}
