import { cn } from "@/lib/utils";
import type { Message } from "@aula-agente/shared";

interface MessageBubbleProps {
  message: Message;
}

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
          "max-w-[70%] rounded-lg px-3 py-2",
          isContact && "bg-muted",
          isAgent && "bg-primary text-primary-foreground",
          isHuman && "bg-blue-500 text-white"
        )}
      >
        {(isAgent || isHuman) && (
          <p className="mb-1 text-[10px] opacity-70">
            {isAgent ? "Agente" : "Atendente"}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        <p className={cn(
          "mt-1 text-right text-[10px]",
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
