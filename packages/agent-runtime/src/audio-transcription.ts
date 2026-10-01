import { resolveApiKey } from "./vault.js";

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

interface EvolutionMediaResponse {
  base64: string;
  mimetype: string;
}

async function fetchAudioAsMp4(instanceName: string, evolutionMessageId: string): Promise<EvolutionMediaResponse> {
  const response = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      message: { key: { id: evolutionMessageId } },
      convertToMp4: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Evolution media fetch error ${response.status}`);
  }

  const data = await response.json();
  return { base64: data.base64, mimetype: data.mimetype };
}

// Whisper picks its decoder from the file extension in the multipart
// upload, not the mimetype header. Evolution's convertToMp4 always
// returns "audio/mp4" in practice, but this stays defensive for any other
// mimetype it might someday return instead of assuming.
export function pickAudioFileExtension(mimetype: string): string {
  if (mimetype.includes("mp4")) return "mp4";
  if (mimetype.includes("mpeg") || mimetype.includes("mp3")) return "mp3";
  if (mimetype.includes("wav")) return "wav";
  if (mimetype.includes("webm")) return "webm";
  return "mp4";
}

async function transcribeWithWhisper(base64Audio: string, mimetype: string, apiKey: string): Promise<string> {
  const buffer = Buffer.from(base64Audio, "base64");
  const extension = pickAudioFileExtension(mimetype);

  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimetype }), `audio.${extension}`);
  formData.append("model", "whisper-1");
  formData.append("language", "pt");

  const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI transcription error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return typeof data.text === "string" ? data.text : "";
}

export type TranscriptionResult = { ok: true; text: string } | { ok: false; reason: string };

export async function transcribeAudioMessage(params: {
  instanceName: string;
  evolutionMessageId: string;
  organizationId: string;
}): Promise<TranscriptionResult> {
  try {
    const apiKey = await resolveApiKey(params.organizationId, "openai");
    const { base64, mimetype } = await fetchAudioAsMp4(params.instanceName, params.evolutionMessageId);
    const text = await transcribeWithWhisper(base64, mimetype, apiKey);

    if (!text.trim()) {
      return { ok: false, reason: "empty_transcription" };
    }

    return { ok: true, text: text.trim() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}
