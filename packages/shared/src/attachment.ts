// Validação de anexo do chat pelos bytes (nunca confia no content-type nem só na extensão enviada).
export const ATTACHMENT_LIMIT_PER_HOUR = 60;

export interface AttachmentFormat {
  kind: "image" | "video" | "document";
  mime: string;
  extension: string;
}

const TEXT_SNIFF_BYTES = 8 * 1024;

const OFFICE_ZIP_MIMES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const OLE_MIMES: Record<string, string> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
};

const TEXT_MIMES: Record<string, string> = {
  txt: "text/plain",
  csv: "text/csv",
};

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, i) => bytes[offset + i] === value);
}

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return "";
  return fileName.slice(dot + 1).trim().toLowerCase();
}

/**
 * Identifica o anexo pelos bytes iniciais e exige que a extensão do nome combine com o formato
 * detectado. Qualquer divergência (ou formato fora da lista) devolve null.
 */
export function detectAttachmentFormat(buffer: Uint8Array, fileName: string): AttachmentFormat | null {
  if (buffer.length === 0) return null;
  const ext = fileExtension(fileName);

  // Imagens
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return ext === "jpg" || ext === "jpeg" ? { kind: "image", mime: "image/jpeg", extension: "jpg" } : null;
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ext === "png" ? { kind: "image", mime: "image/png", extension: "png" } : null;
  }
  // "RIFF" .... "WEBP"
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return ext === "webp" ? { kind: "image", mime: "image/webp", extension: "webp" } : null;
  }

  // Vídeo: caixa "ftyp" no offset 4; marca "qt  " é QuickTime
  if (startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
    if (startsWith(buffer, [0x71, 0x74, 0x20, 0x20], 8)) {
      return ext === "mov" ? { kind: "video", mime: "video/quicktime", extension: "mov" } : null;
    }
    return ext === "mp4" || ext === "m4v" ? { kind: "video", mime: "video/mp4", extension: "mp4" } : null;
  }

  // Documentos
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) {
    return ext === "pdf" ? { kind: "document", mime: "application/pdf", extension: "pdf" } : null;
  }
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    const mime = OFFICE_ZIP_MIMES[ext];
    return mime ? { kind: "document", mime, extension: ext } : null;
  }
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0])) {
    const mime = OLE_MIMES[ext];
    return mime ? { kind: "document", mime, extension: ext } : null;
  }

  const textMime = TEXT_MIMES[ext];
  if (textMime) {
    const limit = Math.min(buffer.length, TEXT_SNIFF_BYTES);
    for (let i = 0; i < limit; i++) {
      if (buffer[i] === 0) return null;
    }
    return { kind: "document", mime: textMime, extension: ext };
  }

  return null;
}
