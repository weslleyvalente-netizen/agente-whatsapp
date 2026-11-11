"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatBytes } from "@/lib/chat-media";
import {
  ATTACHMENT_CAPTION_MAX,
  DOCUMENT_ACCEPT,
  IMAGE_VIDEO_ACCEPT,
  attachmentErrorMessage,
  firstFileOf,
  validateAttachmentFile,
} from "@/lib/attachment-picker";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// Arquivo solto na área de mensagens (o ChatPanel detecta o arraste). `id` novo = arquivo novo.
export interface DroppedFiles {
  id: number;
  files: File[];
}

interface AttachmentComposerProps {
  conversationId: string;
  disabled?: boolean;
  onSent: () => void;
  dropped?: DroppedFiles | null;
  // Chamado logo depois de abrir o arquivo solto: o pai limpa o estado e o arraste nunca reabre.
  onConsumed?: () => void;
}

// Nome só para exibição: sem caminho, sem caracteres de controle/direção, tamanho limitado.
function safeDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const clean = base.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean || "arquivo";
}

// Clipe + diálogo de pré-visualização com legenda. Invisível sem a chave
// seller_attachments_enabled da organização.
export function AttachmentComposer({ conversationId, disabled = false, onSent, dropped = null, onConsumed }: AttachmentComposerProps) {
  const { currentOrg } = useOrganization();
  const enabled = currentOrg?.settings.seller_attachments_enabled === true;

  const mediaInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<{ file: File; previewUrl: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const file = selected?.file ?? null;
  const previewUrl = selected?.previewUrl ?? null;
  const validation = file ? validateAttachmentFile({ name: file.name, size: file.size, type: file.type }) : null;
  const kind = validation && validation.ok ? validation.kind : null;

  // URL da miniatura/player criada ao escolher o arquivo e revogada ao trocar/fechar,
  // então nenhum <img>/<video> aponta para uma URL já revogada.
  const urlRef = useRef<string | null>(null);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const revokePreview = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };
  useEffect(() => revokePreview, []);

  const open = (files: ArrayLike<File>) => {
    const { file: first, multiple } = firstFileOf(files);
    if (!first || sending) return;
    revokePreview();
    const v = validateAttachmentFile({ name: first.name, size: first.size, type: first.type });
    const url = v.ok && (v.kind === "image" || v.kind === "video") ? URL.createObjectURL(first) : null;
    urlRef.current = url;
    setSelected({ file: first, previewUrl: url });
    setError(null);
    setNotice(multiple ? "Envie um arquivo por vez." : null);
  };

  const reset = () => {
    revokePreview();
    setSelected(null);
    setCaption("");
    setError(null);
    setNotice(null);
  };

  const close = () => {
    if (sending) return;
    reset();
  };

  // Troca de conversa: descarta o que estava pendente.
  useEffect(() => {
    reset();
    setSending(false);
  }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arquivo solto na área de mensagens.
  useEffect(() => {
    if (!dropped) return;
    if (enabled && !disabled) open(dropped.files);
    onConsumed?.();
  }, [dropped?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled) return null;

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    open(list);
  };

  const send = async () => {
    if (!file || !validation || !validation.ok || sending) return;
    const sentFor = conversationId;
    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      // A API para de ler campos no primeiro arquivo: conversation_id e caption vêm ANTES de "file".
      form.append("conversation_id", conversationId);
      const text = caption.trim();
      if (text) form.append("caption", text);
      form.append("file", file, file.name);
      await apiFetch("/messages/send-attachment", { method: "POST", body: form });
      // Resposta de uma conversa que já não está na tela: ignora (o estado foi zerado na troca).
      if (conversationRef.current !== sentFor) return;
      setSending(false);
      reset();
      onSent();
    } catch (err) {
      if (conversationRef.current !== sentFor) return;
      setError(attachmentErrorMessage(err));
      setSending(false);
    }
  };

  const canSend = Boolean(validation?.ok) && !sending;

  return (
    <>
      <input ref={mediaInputRef} type="file" accept={IMAGE_VIDEO_ACCEPT} className="hidden" onChange={onPick} data-testid="attachment-input-media" />
      <input ref={docInputRef} type="file" accept={DOCUMENT_ACCEPT} className="hidden" onChange={onPick} data-testid="attachment-input-document" />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label="Anexar arquivo"
          title="Anexar"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
        >
          <Paperclip className="h-5 w-5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-44">
          <DropdownMenuItem onClick={() => mediaInputRef.current?.click()}>Imagem ou vídeo</DropdownMenuItem>
          <DropdownMenuItem onClick={() => docInputRef.current?.click()}>Documento</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={file !== null} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>Enviar anexo</DialogTitle>
            <Button type="button" variant="ghost" size="icon-sm" onClick={close} disabled={sending} aria-label="Fechar" title="Fechar">
              <X className="h-4 w-4" />
            </Button>
          </div>
          {file && (
            <div className="space-y-3">
              {kind === "image" && previewUrl && (
                <img src={previewUrl} alt="Pré-visualização da imagem" className="mx-auto max-h-64 w-auto max-w-full rounded-md object-contain" />
              )}
              {kind === "video" && previewUrl && (
                <video src={previewUrl} controls preload="metadata" className="mx-auto max-h-64 w-full rounded-md bg-black" />
              )}
              {(kind === "document" || !validation?.ok) && (
                <div className="flex items-center gap-3 rounded-md border p-3">
                  <FileText className="h-8 w-8 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{safeDisplayName(file.name)}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                  </div>
                </div>
              )}
              {kind && kind !== "document" && (
                <p className="truncate text-xs text-muted-foreground">{safeDisplayName(file.name)} · {formatBytes(file.size)}</p>
              )}
              {validation && !validation.ok && (
                <p role="alert" className="text-sm font-medium text-destructive">{validation.error}</p>
              )}
              {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                maxLength={ATTACHMENT_CAPTION_MAX}
                rows={2}
                disabled={sending}
                placeholder="Adicione uma legenda"
                aria-label="Legenda"
                className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
              />
              {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
              <div className="flex items-center justify-end gap-2">
                {sending && (
                  <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Enviando...
                  </span>
                )}
                <Button type="button" variant="outline" onClick={close} disabled={sending} aria-label="Cancelar envio">Cancelar</Button>
                <Button type="button" onClick={send} disabled={!canSend} aria-label="Enviar anexo">
                  {error ? "Tentar de novo" : "Enviar"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
