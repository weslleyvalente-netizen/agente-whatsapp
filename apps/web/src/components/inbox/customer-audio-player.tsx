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
  // Já houve um novo link automático após erro de reprodução? Evita laço de re-assinatura.
  const retriedAfterErrorRef = useRef(false);
  const duration = formatAudioDuration(durationSeconds);

  async function load(fromUserTap = true) {
    if (fromUserTap) retriedAfterErrorRef.current = false;
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

  // Assim que o src novo entra no <audio>: toca direto (com preload="none" o
  // loadedmetadata pode nunca disparar antes do play) e retoma de onde parou.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src || !autoPlayRef.current) return;
    autoPlayRef.current = false;
    const resumeAt = resumeAtRef.current;
    resumeAtRef.current = 0;
    if (resumeAt > 0) {
      el.addEventListener("loadedmetadata", () => { el.currentTime = resumeAt; }, { once: true });
    }
    // Alguns navegadores de celular bloqueiam o play fora do toque: os controles continuam visíveis.
    el.play().catch(() => {});
  }, [src]);

  // Link vencido ou arquivo apagado: volta ao botão para pedir outro link ao tocar de novo.
  // Uma única renovação automática; se falhar de novo, "Áudio indisponível".
  function handleAudioError() {
    resumeAtRef.current = audioRef.current?.currentTime ?? 0;
    setSrc(null);
    if (retriedAfterErrorRef.current) {
      setStatus("error");
      setErrorText("Áudio indisponível");
      return;
    }
    retriedAfterErrorRef.current = true;
    void load(false);
  }

  if (status === "ready" && src) {
    return (
      <audio
        ref={audioRef}
        src={src}
        controls
        preload="none"
        onPlaying={() => { retriedAfterErrorRef.current = false; }}
        onError={handleAudioError}
        className="h-11 w-full min-w-[220px] max-w-full"
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void load()}
        disabled={status === "loading"}
        aria-busy={status === "loading"}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-70"
      >
        {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        Ouvir áudio{duration ? ` · ${duration}` : ""}
      </button>
      {errorText && (
        <p role="alert" className="mt-1 text-xs text-muted-foreground">
          {errorText}
        </p>
      )}
    </div>
  );
}
