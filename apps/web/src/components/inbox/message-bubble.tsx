import { Check, Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import { WA_THEME, messageTick } from "@/lib/whatsapp-layout";
import type { Message } from "@aula-agente/shared";
import { hasStoredAudio } from "@/lib/customer-audio";
import { CustomerAudioPlayer } from "./customer-audio-player";

interface MessageBubbleProps {
  message: Message;
  // Layout WhatsApp (flag da organização). Desligado = bolha de sempre.
  waLayout?: boolean;
  // Primeira bolha de uma sequência do mesmo lado: desenha o "rabinho".
  tail?: boolean;
}

// The webhook saves every incoming voice note with this exact placeholder
// (apps/api/src/routes/webhooks/evolution.ts) before the worker attempts
// transcription. If transcription succeeds, the worker overwrites content
// with "🎤 <transcript>" (apps/worker/src/workers/process-message.ts); if
// it fails, content is left exactly as this placeholder. So an incoming
// audio message still showing it means the AI never actually "heard" what
// the customer said — showing that literal bracket text as if it were
// real content would be misleading, and silently showing nothing would
// hide that a reply might be missing context.
const UNTRANSCRIBED_AUDIO_PLACEHOLDER = "[audio]";

export function MessageBubble({ message, waLayout = false, tail = false }: MessageBubbleProps) {
  const isContact = message.role === "contact";
  const isAgent = message.role === "agent";
  const isHuman = message.role === "human_agent";
  const isSystem = message.role === "system";

  const isPlaceholderAudio = message.media_type === "audio" && message.content === UNTRANSCRIBED_AUDIO_PLACEHOLDER;
  const showUntranscribedNotice = isContact && isPlaceholderAudio;
  const hideHumanAudioPlaceholder =
    isHuman && isPlaceholderAudio && (hasStoredAudio(message) || Boolean(message.metadata?.send_failed_at));
  const showHumanAudioLabel = isHuman && isPlaceholderAudio && !hideHumanAudioPlaceholder;

  if (waLayout) {
    return (
      <WaMessageBubble
        message={message}
        tail={tail}
        showUntranscribedNotice={showUntranscribedNotice}
        hideHumanAudioPlaceholder={hideHumanAudioPlaceholder}
        showHumanAudioLabel={showHumanAudioLabel}
      />
    );
  }

  if (isSystem) {
    return (
      <div className="flex justify-center py-2">
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex", isContact ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "min-w-0 max-w-[85%] md:max-w-[70%] rounded-lg px-3 py-2",
          isContact && "bg-muted",
          isAgent && "bg-primary/10 text-foreground",
          isHuman && "bg-steel text-white"
        )}
      >
        {(isAgent || isHuman) && (
          <p className={cn("mb-1 text-[10px] font-semibold", isAgent ? "text-primary" : "opacity-70")}>
            {isAgent ? "Agente" : "Atendente"}
          </p>
        )}
        {message.media_type === "image" && message.media_url && (
          <img
            src={message.media_url}
            alt="Foto enviada"
            className="mb-1 h-auto max-w-full rounded-md"
          />
        )}
        {(isContact || isHuman) && hasStoredAudio(message) && (
          <div className="mb-1">
            <CustomerAudioPlayer messageId={message.id} durationSeconds={message.metadata?.duration_seconds} />
          </div>
        )}
        {showUntranscribedNotice ? (
          <p className="flex items-center gap-1.5 text-sm italic text-muted-foreground">
            <Mic className="h-3.5 w-3.5 shrink-0" />
            Áudio sem transcrição — conteúdo não verificado
          </p>
        ) : hideHumanAudioPlaceholder ? null : showHumanAudioLabel ? (
          <p className="flex items-center gap-1.5 text-sm italic opacity-70">
            <Mic className="h-3.5 w-3.5 shrink-0" />
            Áudio
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
        )}
        {isHuman && message.media_type === "audio" && message.metadata?.send_failed_at && (
          <p className="mt-1 text-xs font-semibold text-destructive">Áudio não enviado</p>
        )}
        <p
          title={new Date(message.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full", timeStyle: "medium" })}
          className={cn(
          "tabular-data mt-1 text-right text-[10px]",
          isContact ? "text-muted-foreground" : "opacity-70"
        )}>
          {new Date(message.created_at).toLocaleTimeString("pt-BR", {
            timeZone: "America/Sao_Paulo",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}

interface WaMessageBubbleProps {
  message: Message;
  tail: boolean;
  showUntranscribedNotice: boolean;
  hideHumanAudioPlaceholder: boolean;
  showHumanAudioLabel: boolean;
}

// Bolha do layout WhatsApp: mesmos ramos de conteúdo (imagem, áudio,
// avisos), só com outra pele — cantos, rabinho, hora e ✓ dentro do balão.
function WaMessageBubble({ message, tail, showUntranscribedNotice, hideHumanAudioPlaceholder, showHumanAudioLabel }: WaMessageBubbleProps) {
  const isContact = message.role === "contact";
  const isAgent = message.role === "agent";
  const isHuman = message.role === "human_agent";

  if (message.role === "system") {
    return (
      <div className="flex justify-center py-2">
        <span className={cn("rounded-lg px-3 py-1 text-xs shadow-sm", WA_THEME.systemPill)}>{message.content}</span>
      </div>
    );
  }

  const out = !isContact;
  const tick = messageTick(message);
  const audioFailed = isHuman && message.media_type === "audio" && Boolean(message.metadata?.send_failed_at);

  return (
    <div className={cn("flex", out ? "justify-end pr-2" : "justify-start pl-2")}>
      <div
        className={cn(
          "relative min-w-0 max-w-[85%] rounded-lg px-2.5 pb-1 pt-1.5 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] md:max-w-[65%]",
          isAgent ? WA_THEME.bubbleAi : out ? WA_THEME.bubbleOut : WA_THEME.bubbleIn,
          tail && (out ? "rounded-tr-none" : "rounded-tl-none")
        )}
      >
        {tail && (
          <svg
            viewBox="0 0 8 13"
            aria-hidden
            className={cn("absolute top-0 h-[13px] w-2", out ? cn("-right-2", isAgent ? WA_THEME.tailAi : WA_THEME.tailOut) : cn("-left-2", WA_THEME.tailIn))}
          >
            <path fill="currentColor" d={out ? "M0 0h8L0 11z" : "M8 0H0l8 11z"} />
          </svg>
        )}
        {(isAgent || isHuman) && (
          <p className={cn("mb-0.5 text-[11px] font-semibold", isAgent ? WA_THEME.aiText : WA_THEME.meta)}>
            {isAgent ? "IA" : "Atendente"}
          </p>
        )}
        {message.media_type === "image" && message.media_url && (
          <img src={message.media_url} alt="Foto enviada" className="mb-1 h-auto max-w-full rounded-md" />
        )}
        {(isContact || isHuman) && hasStoredAudio(message) && (
          <div className="mb-1">
            <CustomerAudioPlayer messageId={message.id} durationSeconds={message.metadata?.duration_seconds} />
          </div>
        )}
        {showUntranscribedNotice ? (
          <p className={cn("flex items-center gap-1.5 text-sm italic", WA_THEME.meta)}>
            <Mic className="h-3.5 w-3.5 shrink-0" />
            Áudio sem transcrição — conteúdo não verificado
          </p>
        ) : hideHumanAudioPlaceholder ? null : showHumanAudioLabel ? (
          <p className={cn("flex items-center gap-1.5 text-sm italic", WA_THEME.meta)}>
            <Mic className="h-3.5 w-3.5 shrink-0" />
            Áudio
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-[19px]">{message.content}</p>
        )}
        {audioFailed && <p className="mt-1 text-xs font-semibold text-destructive">Áudio não enviado</p>}
        <div className={cn("tabular-data mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none", WA_THEME.meta)}>
          <span
            title={new Date(message.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full", timeStyle: "medium" })}
          >
            {new Date(message.created_at).toLocaleTimeString("pt-BR", {
              timeZone: "America/Sao_Paulo",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {tick === "sent" && <Check className="h-3.5 w-3.5" role="img" aria-label="Enviada" />}
          {tick === "failed" && !audioFailed && <span className="font-semibold text-destructive">não enviado</span>}
        </div>
      </div>
    </div>
  );
}
