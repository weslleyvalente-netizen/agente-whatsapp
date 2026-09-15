import { resolveApiKey } from "@aula-agente/agent-runtime";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

// A link read aloud is useless (the customer can't tap it), and a list of
// 2+ options/prices is hard to follow by ear — both fall back to text even
// when the audio-replies toggle and the "customer sent audio" gate are
// satisfied.
const LIST_LINE_PATTERN = /^\s*(🔹|-|•|\d+[.)])/;

// ~40 seconds spoken — keeps voice replies conversational-length instead of
// turning a long reply into a multi-minute voice note nobody wants to sit
// through; also stays safely under OpenAI's 4096-char /v1/audio/speech cap.
const MAX_AUDIO_TEXT_LENGTH = 600;

export function isSimpleEnoughForAudio(text: string): boolean {
  if (text.length > MAX_AUDIO_TEXT_LENGTH) return false;
  if (/https?:\/\//i.test(text)) return false;
  const listLineCount = text.split("\n").filter((line) => LIST_LINE_PATTERN.test(line)).length;
  return listLineCount < 2;
}

async function requestSpeech(text: string, voice: string, apiKey: string): Promise<string> {
  const response = await fetch(OPENAI_SPEECH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: "tts-1", voice, input: text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI speech error ${response.status}: ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}

export type SpeechResult = { ok: true; audioBase64: string } | { ok: false; reason: string };

export async function generateSpeech(params: {
  text: string;
  voice: string;
  organizationId: string;
}): Promise<SpeechResult> {
  try {
    const apiKey = await resolveApiKey(params.organizationId, "openai");
    const audioBase64 = await requestSpeech(params.text, params.voice, apiKey);
    return { ok: true, audioBase64 };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}
