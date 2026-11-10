import { CHAT_MEDIA_MAX_BYTES } from "@aula-agente/shared";

export type AttachmentKind = "image" | "video" | "document";

const EXTENSIONS: Record<string, AttachmentKind> = {
  jpg: "image", jpeg: "image", png: "image", webp: "image",
  mp4: "video", mov: "video",
  pdf: "document", doc: "document", docx: "document", xls: "document", xlsx: "document",
  ppt: "document", pptx: "document", txt: "document", csv: "document",
};

export const ATTACHMENT_CAPTION_MAX = 1000;
export const IMAGE_VIDEO_ACCEPT = ".jpg,.jpeg,.png,.webp,.mp4,.mov";
export const DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv";

export type AttachmentValidation = { ok: true; kind: AttachmentKind } | { ok: false; error: string };

// Checagem rápida no navegador (extensão e tamanho); a API valida os bytes de verdade.
export function validateAttachmentFile(f: { name: string; size: number; type: string }): AttachmentValidation {
  const match = /^[^.].*\.([A-Za-z0-9]+)$/.exec(f.name.trim());
  // Vale a última extensão: "a.pdf.exe" e nomes sem extensão são recusados.
  const kind = match ? EXTENSIONS[match[1].toLowerCase()] : undefined;
  if (!kind) return { ok: false, error: "Tipo de arquivo não suportado" };
  if (f.size <= 0) return { ok: false, error: "Arquivo vazio" };
  const max = CHAT_MEDIA_MAX_BYTES[kind];
  if (f.size > max) return { ok: false, error: `Arquivo acima de ${Math.round(max / (1024 * 1024))} MB` };
  return { ok: true, kind };
}

// Vários arquivos: usa o primeiro e sinaliza para avisar a atendente.
export function firstFileOf<T>(files: ArrayLike<T>): { file: T | null; multiple: boolean } {
  return { file: files.length > 0 ? files[0] : null, multiple: files.length > 1 };
}

// Mensagem da API é mostrada como veio; falha de rede (fetch rejeita com TypeError) vira texto em português.
export function attachmentErrorMessage(err: unknown): string {
  if (err instanceof TypeError) return "Sem conexão. Tente de novo.";
  if (err instanceof Error && err.message) return err.message;
  return "Erro ao enviar o anexo";
}
