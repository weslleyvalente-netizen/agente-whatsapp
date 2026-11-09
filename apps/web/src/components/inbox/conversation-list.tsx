"use client";

import { cn, formatPhone } from "@/lib/utils";
import { ContactAvatar } from "./contact-avatar";
import { Badge } from "@/components/ui/badge";
import { StatusLamp, type LampTone } from "@/components/ui/status-lamp";
import { WA_THEME } from "@/lib/whatsapp-layout";

interface ConversationItem {
  id: string;
  status: string;
  is_human_takeover: boolean;
  last_message_at: string;
  tags: string[];
  assigned_to: string | null;
  unread: boolean;
  wa_contacts: {
    id: string;
    profile_picture_path?: string | null;
    phone: string;
    name: string | null;
    ai_disabled: boolean;
  };
  agents: {
    name: string;
  };
  messages?: Array<{ content: string; created_at: string }>;
}

interface ConversationListProps {
  conversations: ConversationItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  moreError?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  // Layout WhatsApp (flag da organização). Desligado = lista de sempre.
  waLayout?: boolean;
}

// Derived purely from fields already on the conversation — no schema change.
// Mirrors the multi-badge pattern seen in Assis: a conversation the AI is
// handling fine shows no badge at all (visual noise reduction), while one
// that needs human eyes stacks up to three. "Disponível para assumir" is
// plain colored text rather than a badge — same distinction Assis draws
// between a status pill and a lighter-weight annotation.
function getConversationTags(
  conv: ConversationItem
): Array<{ label: string; kind: "badge"; variant: "tonal" | "destructive" } | { label: string; kind: "text" }> {
  const tags: Array<{ label: string; kind: "badge"; variant: "tonal" | "destructive" } | { label: string; kind: "text" }> = [];
  if (conv.status === "open" || conv.status === "waiting") {
    tags.push({ label: "Em andamento", kind: "badge", variant: "tonal" });
  }
  if (conv.wa_contacts.ai_disabled) {
    tags.push({ label: "IA desativada", kind: "badge", variant: "destructive" });
  }
  if (conv.is_human_takeover) {
    tags.push({ label: "Atenção Humana", kind: "badge", variant: "destructive" });
    if (!conv.assigned_to) {
      tags.push({ label: "Disponível para assumir", kind: "text" });
    }
  }
  return tags;
}

// Mesmas etiquetas da lista de sempre, usadas pelo layout WhatsApp.
function renderTags(conv: ConversationItem) {
  const tags = getConversationTags(conv);
  if (tags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) =>
        tag.kind === "badge" ? (
          <Badge key={tag.label} variant={tag.variant} className="h-4 px-1.5 text-[10px] font-semibold">
            {tag.label}
          </Badge>
        ) : (
          <span key={tag.label} className="text-[10px] font-semibold text-destructive">
            {tag.label}
          </span>
        )
      )}
    </div>
  );
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  loading = false,
  error = false,
  onRetry,
  moreError = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  waLayout = false,
}: ConversationListProps) {
  const statusLamp: Record<string, LampTone> = {
    open: "green",
    waiting: "amber",
    resolved: "off",
    closed: "off",
  };

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">Carregando...</div>;
  }
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
        <span>Não foi possível carregar as conversas.</span>
        <button onClick={onRetry} className="rounded-full border px-4 py-2 font-medium text-foreground hover:bg-accent">
          Tentar de novo
        </button>
      </div>
    );
  }
  if (conversations.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">Nenhuma conversa</div>;
  }

  return (
    <div className="flex flex-col">
      {conversations.map((conv) => waLayout ? (
        <button
          key={conv.id}
          onClick={() => onSelect(conv.id)}
          className={cn(
            "flex items-center gap-3 pl-3 text-left transition-colors",
            WA_THEME.listItem,
            selectedId === conv.id && WA_THEME.listItemSelected
          )}
        >
          <div className="relative shrink-0 py-2.5">
            <ContactAvatar
              contactId={conv.wa_contacts.id}
              name={conv.wa_contacts.name}
              phone={conv.wa_contacts.phone}
              picturePath={conv.wa_contacts.profile_picture_path}
              className="h-12 w-12"
            />
            <span className="absolute bottom-2 -right-0.5 rounded-full bg-background p-[3px]">
              <StatusLamp tone={statusLamp[conv.status] || "off"} pulse={conv.status === "waiting"} />
            </span>
          </div>
          <div className={cn("min-w-0 flex-1 border-b py-3 pr-3", WA_THEME.divider)}>
            <div className="flex items-baseline justify-between gap-2">
              <p className={cn("truncate text-[15px]", WA_THEME.title, conv.unread ? "font-semibold" : "font-normal")}>
                {conv.wa_contacts.name || formatPhone(conv.wa_contacts.phone)}
              </p>
              <span className={cn("shrink-0 text-xs tabular-data", conv.unread ? cn("font-medium", WA_THEME.accentText) : WA_THEME.meta)}>
                {new Date(conv.last_message_at).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-2">
              <p className={cn("truncate text-sm", conv.unread ? WA_THEME.title : WA_THEME.meta)}>
                {conv.messages?.[0]?.content || conv.agents.name}
              </p>
              {conv.unread && <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", WA_THEME.unreadDot)} aria-label="Não lida" />}
            </div>
            {renderTags(conv)}
          </div>
        </button>
      ) : (
        <button
          key={conv.id}
          onClick={() => onSelect(conv.id)}
          className={cn(
            "flex items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-accent/50",
            selectedId === conv.id && "bg-accent"
          )}
        >
          <div className="relative shrink-0">
            <ContactAvatar
              contactId={conv.wa_contacts.id}
              name={conv.wa_contacts.name}
              phone={conv.wa_contacts.phone}
              picturePath={conv.wa_contacts.profile_picture_path}
            />
            <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-background p-[3px]">
              <StatusLamp tone={statusLamp[conv.status] || "off"} pulse={conv.status === "waiting"} />
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <div className="flex items-center justify-between gap-2">
              <p
                className={cn(
                  "truncate text-sm",
                  conv.unread ? "font-semibold text-foreground" : "font-medium text-muted-foreground"
                )}
              >
                {conv.wa_contacts.name || formatPhone(conv.wa_contacts.phone)}
              </p>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-data">
                {conv.unread && <span className="h-2 w-2 rounded-full bg-primary" aria-label="Não lida" />}
                {new Date(conv.last_message_at).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {conv.messages?.[0]?.content || conv.agents.name}
            </p>
            {(() => {
              const tags = getConversationTags(conv);
              if (tags.length === 0) return null;
              return (
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {tags.map((tag) =>
                    tag.kind === "badge" ? (
                      <Badge key={tag.label} variant={tag.variant} className="h-4 px-1.5 text-[10px] font-semibold">
                        {tag.label}
                      </Badge>
                    ) : (
                      <span key={tag.label} className="text-[10px] font-semibold text-destructive">
                        {tag.label}
                      </span>
                    )
                  )}
                </div>
              );
            })()}
          </div>
        </button>
      ))}
      {hasMore && (
        <button
          onClick={onLoadMore}
          disabled={loadingMore}
          className="m-3 rounded-full border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          {loadingMore ? "Carregando..." : moreError ? "Erro ao carregar. Tentar de novo" : "Carregar mais"}
        </button>
      )}
    </div>
  );
}
