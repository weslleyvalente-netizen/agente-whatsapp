const ELEVENLABS_SPEECH_URL = "https://api.elevenlabs.io/v1/text-to-speech";

// Multilingual model — needed since replies are in Portuguese, not English.
const ELEVENLABS_MODEL = "eleven_multilingual_v2";

// A link read aloud is useless (the customer can't tap it), and a list of
// 2+ options/prices is hard to follow by ear — both fall back to text even
// when the audio-replies toggle and the "customer sent audio" gate are
// satisfied. Bullet markers vary by product category (🔹 for general lists,
// 🏍️ for motorcycles, etc. — confirmed live: a real reply bulleted with 🏍️
// slipped through the old fixed-emoji allowlist and went out as audio), so
// this matches ANY leading emoji via \p{Extended_Pictographic} rather than
// enumerating specific ones.
const LIST_LINE_PATTERN = /^\s*(\p{Extended_Pictographic}|-|•|\d+[.)])/u;

// ~40 seconds spoken — keeps voice replies conversational-length instead of
// turning a long reply into a multi-minute voice note nobody wants to sit
// through; also stays comfortably under any TTS provider's input cap.
const MAX_AUDIO_TEXT_LENGTH = 600;

export function isSimpleEnoughForAudio(text: string): boolean {
  if (text.length > MAX_AUDIO_TEXT_LENGTH) return false;
  if (/https?:\/\//i.test(text)) return false;
  const listLineCount = text.split("\n").filter((line) => LIST_LINE_PATTERN.test(line)).length;
  return listLineCount < 2;
}

// ElevenLabs' Portuguese model reads "Fazer" — the Yamaha model, spoken
// like "féizer" — as the Portuguese verb "fazer" ("to do"). Confirmed live
// in a real audio reply about the Fazer 150/250. Respell known brand names
// phonetically for the TTS call only; the customer-facing text saved to
// messages.content is untouched by this.
const TTS_PRONUNCIATION_FIXES: Array<[RegExp, string]> = [[/\bFazer\b/gi, "Féizer"]];

function applyPronunciationFixes(text: string): string {
  return TTS_PRONUNCIATION_FIXES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

async function requestSpeech(text: string, voiceId: string, apiKey: string): Promise<string> {
  const response = await fetch(`${ELEVENLABS_SPEECH_URL}/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs speech error ${response.status}: ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}

export type SpeechResult = { ok: true; audioBase64: string } | { ok: false; reason: string };

// `voice` here is an ElevenLabs voice_id (a library hash, e.g. copied from
// the "Copiar ID de voz" menu in the Voice Library UI) — not a named preset
// like OpenAI's "alloy". `apiKey` is resolved by the caller via
// resolveElevenLabsApiKey (organization_secrets vault, falling back to the
// ELEVENLABS_API_KEY env var) — this module has no env/DB access of its own.
export async function generateSpeech(params: {
  text: string;
  voice: string;
  apiKey: string | null;
}): Promise<SpeechResult> {
  if (!params.apiKey) {
    return { ok: false, reason: "ELEVENLABS_API_KEY is not set" };
  }

  try {
    const audioBase64 = await requestSpeech(applyPronunciationFixes(params.text), params.voice, params.apiKey);
    return { ok: true, audioBase64 };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}
