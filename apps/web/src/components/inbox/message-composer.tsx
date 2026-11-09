"use client";

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { SendHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { WA_THEME, composerHeight } from "@/lib/whatsapp-layout";

const MAX_ROWS = 6;

interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled?: boolean;
  placeholder: string;
  // Ações ao lado do campo (ex.: botão de gravar áudio).
  extraActions?: ReactNode;
}

// Composer do layout WhatsApp: campo multilinha que cresce até 6 linhas.
// Enter envia, Shift+Enter quebra linha.
export function MessageComposer({ value, onChange, onSend, sending, disabled = false, placeholder, extraActions }: MessageComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const blocked = sending || disabled;
  const canSend = !blocked && value.trim().length > 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    el.style.height = "auto";
    const next = composerHeight(el.scrollHeight, lineHeight, paddingY, MAX_ROWS);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > next ? "auto" : "hidden";
  }, [value]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div className="flex min-w-0 flex-1 items-end gap-2">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={blocked}
        aria-label="Mensagem"
        className={cn(
          "min-w-0 flex-1 resize-none rounded-lg border-0 px-3 py-2.5 text-base leading-5 outline-none focus-visible:ring-2 focus-visible:ring-[#00a884]/40 disabled:cursor-not-allowed disabled:opacity-60 md:text-sm md:leading-5",
          WA_THEME.input
        )}
      />
      {extraActions && <div className="flex min-h-10 shrink-0 items-center gap-2">{extraActions}</div>}
      <button
        type="button"
        onClick={onSend}
        disabled={!canSend}
        aria-label="Enviar mensagem"
        title="Enviar"
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          WA_THEME.accentBg
        )}
      >
        <SendHorizontal className="h-5 w-5" />
      </button>
    </div>
  );
}
