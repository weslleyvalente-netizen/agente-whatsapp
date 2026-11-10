"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, Play } from "lucide-react";
import type { Message } from "@aula-agente/shared";
import { apiFetch } from "@/lib/api";
import { chatMediaState, formatBytes } from "@/lib/chat-media";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface MediaUrlResponse {
  url: string;
  expiresIn?: number;
  fileName?: string | null;
  mimeType?: string | null;
}

type LinkStatus = "idle" | "loading" | "ready" | "error";

// Link temporário (~5 min) da mídia guardada no bucket privado. Pede ao ativar
// (`enabled`) e renova uma única vez quando o navegador reclama do link vencido.
// Refaz o pedido quando a referência da mensagem muda (o worker grava a mídia
// depois e o realtime atualiza a bolha no lugar).
function useMediaLink(messageId: string, mediaRef: string | null, enabled: boolean) {
  const [status, setStatus] = useState<LinkStatus>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const renewedRef = useRef(false);

  const fetchLink = useCallback(async () => {
    try {
      const res = (await apiFetch(`/messages/${messageId}/media-url`)) as MediaUrlResponse;
      setUrl(res.url);
      setStatus("ready");
    } catch {
      setUrl(null);
      setStatus("error");
    }
  }, [messageId]);

  // Pedido disparado por toque/renovação (mostra o carregando de imediato).
  const request = useCallback(() => {
    setStatus("loading");
    return fetchLink();
  }, [fetchLink]);

  useEffect(() => {
    renewedRef.current = false;
    if (!enabled || !mediaRef) return;
    let cancelled = false;
    (apiFetch(`/messages/${messageId}/media-url`) as Promise<MediaUrlResponse>)
      .then((res) => {
        if (cancelled) return;
        setUrl(res.url);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setUrl(null);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, mediaRef, messageId]);

  // Link vencido: uma renovação automática; depois disso, erro visível.
  const onLoadError = useCallback(() => {
    if (renewedRef.current) {
      setUrl(null);
      setStatus("error");
      return;
    }
    renewedRef.current = true;
    void request();
  }, [request]);

  const active = enabled && Boolean(mediaRef);
  return { status: active ? status : ("idle" as LinkStatus), url: active ? url : null, request, onLoadError };
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-sm italic opacity-80">{children}</p>;
}

function ImageMedia({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const link = useMediaLink(message.id, message.media_url, true);

  if (link.status === "error") {
    return (
      <div className="flex flex-col items-start gap-1">
        <Notice>Não foi possível carregar a imagem</Notice>
        <Button type="button" variant="outline" size="sm" onClick={() => void link.request()}>
          Tentar de novo
        </Button>
      </div>
    );
  }
  if (!link.url) {
    return (
      <div
        role="status"
        aria-label="Carregando imagem"
        className="flex h-40 w-56 max-w-full items-center justify-center rounded-md bg-black/5"
      >
        <Loader2 className="h-5 w-5 animate-spin opacity-60" />
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ampliar imagem"
        className="block max-w-full overflow-hidden rounded-md"
      >
        <img
          src={link.url}
          alt="Foto enviada pelo cliente"
          onError={link.onLoadError}
          className="max-h-72 w-auto max-w-full object-contain"
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle className="sr-only">Imagem ampliada</DialogTitle>
          <img
            src={link.url}
            alt="Foto enviada pelo cliente, ampliada"
            onError={link.onLoadError}
            className="mx-auto max-h-[80dvh] w-auto max-w-full object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function VideoMedia({ message }: { message: Message }) {
  const [wanted, setWanted] = useState(false);
  const link = useMediaLink(message.id, message.media_url, wanted);
  const loadingVideo = wanted && !link.url && link.status !== "error";

  if (wanted && link.url) {
    return (
      <video
        src={link.url}
        controls
        autoPlay
        preload="metadata"
        onError={link.onLoadError}
        aria-label="Vídeo enviado pelo cliente"
        className="max-h-72 w-full max-w-full rounded-md bg-black"
      />
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => (link.status === "error" ? void link.request() : setWanted(true))}
        disabled={loadingVideo}
        aria-busy={loadingVideo}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-70"
      >
        {loadingVideo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        Reproduzir
      </button>
      {link.status === "error" && (
        <p role="alert" className="text-xs opacity-80">
          Não foi possível carregar o vídeo
        </p>
      )}
    </div>
  );
}

function DocumentMedia({ message }: { message: Message }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const meta = message.metadata?.media;
  const fileName = meta?.file_name?.trim() || "Documento";
  const size = typeof meta?.size_bytes === "number" ? formatBytes(meta.size_bytes) : "";

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const res = (await apiFetch(`/messages/${message.id}/media-url?download=1`)) as MediaUrlResponse;
      const a = document.createElement("a");
      a.href = res.url;
      a.download = res.fileName || meta?.file_name || "";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-[220px] items-center gap-3 rounded-md bg-black/5 p-2">
      <FileText className="h-8 w-8 shrink-0 opacity-70" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={fileName}>
          {fileName}
        </p>
        {size && <p className="text-xs opacity-70">{size}</p>}
        {failed && (
          <p role="alert" className="text-xs text-destructive">
            Não foi possível baixar
          </p>
        )}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => void download()} disabled={busy} aria-busy={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Baixar
      </Button>
    </div>
  );
}

function FailedMedia({ messageId }: { messageId: string }) {
  const [retrying, setRetrying] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      await apiFetch(`/messages/${messageId}/retry-media`, { method: "POST" });
      setQueued(true);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Não foi possível tentar de novo");
    } finally {
      setRetrying(false);
    }
  }

  if (queued) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-sm italic opacity-80">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Baixando de novo…
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Notice>Não foi possível baixar</Notice>
      <Button type="button" variant="outline" size="sm" onClick={() => void retry()} disabled={retrying} aria-busy={retrying}>
        Tentar de novo
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// Imagem, vídeo ou documento da mensagem. O estado é derivado das props, então
// quando o realtime troca pending por stored o conteúdo aparece sem recarregar.
export function ChatMedia({ message }: { message: Message }) {
  const state = chatMediaState(message);

  switch (state) {
    case "none":
      return null;
    case "pending":
      return (
        <p role="status" className="flex items-center gap-1.5 text-sm italic opacity-80">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Carregando mídia…
        </p>
      );
    case "too_large":
      return <Notice>Arquivo grande, abra no celular da loja</Notice>;
    case "expired":
      return <Notice>Arquivo expirado</Notice>;
    case "failed":
      return <FailedMedia messageId={message.id} />;
    case "stored":
      if (message.media_type === "image") return <ImageMedia message={message} />;
      if (message.media_type === "video") return <VideoMedia message={message} />;
      return <DocumentMedia message={message} />;
  }
}
