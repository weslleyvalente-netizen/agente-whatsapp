import { generateText } from "ai";
import { createModel, extractTokenUsage, type TokenUsage } from "@aula-agente/agent-runtime";
import type { LLMProvider } from "@aula-agente/shared";

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;
const IMAGE_SIZE_CAP_BYTES = 10 * 1024 * 1024;

interface EvolutionMediaResponse {
  base64: string;
  mimetype: string;
}

async function fetchImage(instanceName: string, evolutionMessageId: string): Promise<EvolutionMediaResponse> {
  const response = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      message: { key: { id: evolutionMessageId } },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Evolution media fetch error ${response.status}`);
  }

  const data = await response.json();
  return { base64: data.base64, mimetype: data.mimetype };
}

export function exceedsSizeCap(byteLength: number): boolean {
  return byteLength > IMAGE_SIZE_CAP_BYTES;
}

// Kept short on purpose: this becomes part of the conversation history the
// agent reads on every future turn, so a verbose description would eat
// context budget for the rest of the conversation's lifetime.
export function buildImageDescriptionPrompt(caption?: string): string {
  const base =
    "Descreva em português o que aparece nesta imagem, como se estivesse " +
    "contando pra alguém que não pode vê-la. Se for uma moto, identifique " +
    "marca, modelo, cor e estado aparente (arranhões, amassados, pneus etc.) " +
    "quando der pra notar. Seja direto, no máximo 2-3 frases.";

  if (!caption) return base;
  return `${base}\n\nA pessoa que mandou a imagem escreveu junto: "${caption}"`;
}

export type ImageDescriptionResult =
  | { ok: true; text: string; usage: TokenUsage }
  | { ok: false; reason: string; usage?: TokenUsage };

export async function describeImageMessage(params: {
  instanceName: string;
  evolutionMessageId: string;
  caption?: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
}): Promise<ImageDescriptionResult> {
  try {
    const { base64, mimetype } = await fetchImage(params.instanceName, params.evolutionMessageId);
    const byteLength = Buffer.byteLength(base64, "base64");

    if (exceedsSizeCap(byteLength)) {
      return { ok: false, reason: "image_too_large" };
    }

    const model = createModel(params.provider, params.model, params.apiKey);

    const result = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildImageDescriptionPrompt(params.caption) },
            { type: "file", mediaType: mimetype, data: base64 },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(60_000),
    });

    const usage = extractTokenUsage(result.usage);
    console.log(`[image-description] inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens}`);

    if (!result.text.trim()) {
      return { ok: false, reason: "empty_description", usage };
    }

    return { ok: true, text: result.text.trim(), usage };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}
