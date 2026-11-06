"use client";

import { Loader2, Mic, Square, Trash2, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAudioDuration } from "@/lib/customer-audio";

type Phase = "idle" | "recording" | "review" | "sending";

interface AudioRecorderBarProps {
  phase: Phase;
  seconds: number;
  error: string | null;
  canSend: boolean;
  previewUrl: string | null;
  uploadError: string | null;
  onStart: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onSend: () => void;
}

const touch = "size-11 shrink-0 rounded-full md:size-8";

// Em "idle" renderiza só o botão de microfone (cabe ao lado do campo de texto);
// nos demais estados ocupa a linha inteira do compositor.
export function AudioRecorderBar({ phase, seconds, error, canSend, previewUrl, uploadError, onStart, onStop, onDiscard, onSend }: AudioRecorderBarProps) {
  const message = uploadError ?? error;

  if (phase === "idle") {
    return (
      <>
        <Button type="button" variant="outline" size="icon" className={touch} onClick={onStart} aria-label="Gravar áudio" title="Gravar áudio">
          <Mic className="h-4 w-4" />
        </Button>
        {message && <p role="alert" className="absolute bottom-full left-0 right-0 bg-background px-3 py-1 text-xs text-destructive">{message}</p>}
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {message && <p role="alert" className="text-xs text-destructive">{message}</p>}
      <div className="flex min-w-0 items-center gap-2">
        {phase === "recording" ? (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
              <span className="tabular-nums" aria-live="off">{formatAudioDuration(seconds) ?? "0:00"}</span>
            </span>
            <Button type="button" variant="outline" size="icon" className={touch} onClick={onDiscard} aria-label="Cancelar gravação" title="Cancelar">
              <X className="h-4 w-4" />
            </Button>
            <Button type="button" size="icon" className={touch} onClick={onStop} aria-label="Parar gravação" title="Parar">
              <Square className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            {previewUrl && <audio controls src={previewUrl} className="h-11 min-w-0 flex-1 md:h-8" />}
            {phase !== "sending" && (
              <Button type="button" variant="outline" size="icon" className={touch} onClick={onDiscard} aria-label="Descartar áudio" title="Descartar">
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <Button type="button" size="icon" className={touch} onClick={onSend} disabled={!canSend || phase === "sending"} aria-label="Enviar áudio" title="Enviar">
              {phase === "sending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
