"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatAudioDuration } from "@/lib/customer-audio";

type Status = "idle" | "loading" | "ready" | "error";

interface CustomerAudioPlayerProps {
  messageId: string;
  durationSeconds?: number;
}

// Player do áudio do cliente guardado no bucket privado. O link é temporário
// (~5 min): é pedido ao tocar pela primeira vez e de novo se vencer.
export function CustomerAudioPlayer({ messageId, durationSeconds }: CustomerAudioPlayerProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [src, setSrc] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const resumeAtRef = useRef(0);
  const autoPlayRef = useRef(false);
  const duration = formatAudioDuration(durationSeconds);

  async function load() {
    setStatus("loading");
    setErrorText(null);
    try {
      const res = (await apiFetch(`/messages/${messageId}/audio-url`)) as { url: string };
      autoPlayRef.current = true;
      setSrc(res.url);
      setStatus("ready");
    } catch {
      setSrc(null);
      setStatus("error");
      setErrorText("Áudio indisponível");
    }
  }

  // Assim que o src novo entra no <audio>, retoma de onde parou e toca.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src || !autoPlayRef.current) return;
    autoPlayRef.current = false;
    const resumeAt = resumeAtRef.current;
    const start = () => {
      if (resumeAt > 0) el.currentTime = resumeAt;
      // Alguns navegadores de celular bloqueiam o play fora do toque: os controles continuam visíveis.
      el.play().catch(() => {});
    };
    el.addEventListener("loadedmetadata", start, { once: true });
    el.load();
    return () => el.removeEventListener("loadedmetadata", start);
  }, [src]);

  // Link vencido ou arquivo apagado: volta ao botão para pedir outro link ao tocar de novo.
  function handleAudioError() {
    resumeAtRef.current = audioRef.current?.currentTime ?? 0;
    setSrc(null);
    setStatus("idle");
    setErrorText("O link expirou. Toque para ouvir de novo.");
  }

  if (status === "ready" && src) {
    return (
      <audio
        ref={audioRef}
        src={src}
        controls
        preload="none"
        onError={handleAudioError}
        className="h-11 w-full min-w-[220px] max-w-full"
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={load}
        disabled={status === "loading"}
        aria-label="Ouvir áudio"
        className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-70"
      >
        {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        Ouvir{duration ? ` · ${duration}` : ""}
      </button>
      {errorText && (
        <p role="alert" className="mt-1 text-xs text-muted-foreground">
          {errorText}
        </p>
      )}
    </div>
  );
}
