import { Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Message } from "@aula-agente/shared";

interface MessageBubbleProps {
  message: Message;
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

export function MessageBubble({ message }: MessageBubbleProps) {
  const isContact = message.role === "contact";
  const isAgent = message.role === "agent";
  const isHuman = message.role === "human_agent";
  const isSystem = message.role === "system";

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
          "min-w-0 max-w-[70%] rounded-lg px-3 py-2",
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
            className="mb-1 max-w-full rounded-md"
          />
        )}
        {message.media_type === "audio" && isContact && message.content === UNTRANSCRIBED_AUDIO_PLACEHOLDER ? (
          <p className="flex items-center gap-1.5 text-sm italic text-muted-foreground">
            <Mic className="h-3.5 w-3.5 shrink-0" />
            Áudio sem transcrição — conteúdo não verificado
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
        )}
        <p className={cn(
          "tabular-data mt-1 text-right text-[10px]",
          isContact ? "text-muted-foreground" : "opacity-70"
        )}>
          {new Date(message.created_at).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}
