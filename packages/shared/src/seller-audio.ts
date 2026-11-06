// Áudio de voz gravado pelo vendedor no CRM e enviado ao cliente pelo WhatsApp.
export const SELLER_AUDIO_MAX_BYTES = 3 * 1024 * 1024;
export const SELLER_AUDIO_MAX_SECONDS = 300;
export const SELLER_AUDIO_MIN_SECONDS = 1;

export interface SellerAudioFormat {
  extension: "webm" | "mp4" | "ogg";
  mimeType: string;
}

/** Identifica o formato pelos bytes iniciais (nunca confia no content-type enviado pelo cliente). */
export function detectSellerAudioFormat(bytes: Uint8Array): SellerAudioFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { extension: "webm", mimeType: "audio/webm" };
  }
  // "ftyp" nos bytes 4-7
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return { extension: "mp4", mimeType: "audio/mp4" };
  }
  // "OggS"
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return { extension: "ogg", mimeType: "audio/ogg" };
  }
  return null;
}
