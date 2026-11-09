"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { apiFetch } from "@/lib/api";
import { useRouter } from "next/navigation";
import { MessageBubble } from "./message-bubble";
import { ChatHeader } from "./chat-header";
import { SidePanel } from "./side-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Send } from "lucide-react";
import { useOrganization } from "@/providers/organization-provider";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import { AudioRecorderBar } from "./audio-recorder-bar";
import { MessageComposer } from "./message-composer";
import { useWhatsappLayout } from "@/hooks/use-whatsapp-layout";
import { WA_THEME, startsBubbleGroup } from "@/lib/whatsapp-layout";
import { cn } from "@/lib/utils";
import { chatDayKey, chatDayLabel } from "@aula-agente/shared";
import type { Message } from "@aula-agente/shared";

interface ChatPanelProps {
  conversationId: string;
  compact?: boolean;
  onClose?: () => void;
  onConversationChanged?: () => void;
  // Rascunho vindo de fora (ex.: "Sugerir mensagem" no card): só preenche o campo, nunca envia. `id` novo = rascunho novo.
  draft?: { id: number; text: string } | null;
}

export function ChatPanel({ conversationId, onClose, onConversationChanged, compact = false, draft = null }: ChatPanelProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  // O campo é de uma linha só: quebras viram espaço para o texto não colar.
  useEffect(() => { if (draft) setInput(draft.text.replace(/\s*\n+\s*/g, " ").trim()); }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sending, setSending] = useState(false);
  const [conversation, setConversation] = useState<any>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { currentOrg } = useOrganization();
  const waLayout = useWhatsappLayout();
  const recorder = useAudioRecorder();
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioEnabled = currentOrg?.settings.seller_audio_enabled === true && recorder.supported;
  const recorderBusy = audioEnabled && recorder.phase !== "idle";
  const discardRef = useRef(recorder.discard);
  discardRef.current = recorder.discard;
  // Conversa dona da gravação atual, fixada no início da gravação.
  const recordingOwnerRef = useRef<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const fetchMessages = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    setMessages((data as Message[]) || []);
  }, [conversationId]);

  const fetchConversation = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversations")
      .select("*, wa_contacts(id, phone, name, ai_disabled, profile_picture_path), agents(name)")
      .eq("id", conversationId)
      .single();
    setConversation(data);
  }, [conversationId]);

  const markAsRead = useCallback(async () => {
    if (!userId) return;
    const supabase = createClient();
    await supabase
      .from("conversation_reads")
      .upsert(
        { conversation_id: conversationId, user_id: userId, last_read_at: new Date().toISOString() },
        { onConflict: "conversation_id,user_id" }
      );
  }, [conversationId, userId]);

  useEffect(() => {
    fetchMessages();
    fetchConversation();
  }, [fetchMessages, fetchConversation]);

  useEffect(() => {
    markAsRead();
  }, [markAsRead]);

  // Scroll to bottom on new messages
  useEffect(() => {
    // Rola só a lista de mensagens. scrollIntoView também rolava as áreas
    // "overflow: hidden" acima e empurrava o menu e o topo da página para fora da tela.
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Realtime messages
  useRealtime<Message>({
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`,
    onInsert: (newMsg) => {
      setMessages((prev) => [...prev, newMsg]);
      markAsRead();
    },
    onUpdate: (updatedMsg) => {
      setMessages((prev) => prev.map((m) => (m.id === updatedMsg.id ? { ...m, ...updatedMsg } : m)));
    },
  });

  const handleStatusChange = async (status: string) => {
    const supabase = createClient();
    await supabase
      .from("conversations")
      .update({ status })
      .eq("id", conversationId);
    fetchConversation();
  };

  const handleTakeoverToggle = async () => {
    const nextTakeover = !conversation?.is_human_takeover;

    await apiFetch(`/conversations/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify({ is_human_takeover: nextTakeover }),
    });

    fetchConversation();
    onConversationChanged?.();
  };

  const handleDisableAi = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    await supabase
      .from("wa_contacts")
      .update({
        ai_disabled: true,
        ai_disabled_at: new Date().toISOString(),
        ai_disabled_by: user?.id,
      })
      .eq("id", conversation.wa_contacts.id);

    await apiFetch(`/conversations/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify({ is_human_takeover: true }),
    });

    fetchConversation();
  };

  const handleReenableAi = async () => {
    if (!confirm("Reativar a IA para este contato?")) return;
    const supabase = createClient();

    await supabase
      .from("wa_contacts")
      .update({ ai_disabled: false, ai_disabled_at: null, ai_disabled_by: null })
      .eq("id", conversation.wa_contacts.id);

    fetchConversation();
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    setSending(true);

    try {
      await apiFetch("/messages/send", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          content: input.trim(),
        }),
      });
      setInput("");
      // Task 1's backend change may have just flipped is_human_takeover —
      // refetch so the header button and the notice bar below reflect it
      // immediately instead of waiting for the next realtime event.
      fetchConversation();
      onConversationChanged?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao enviar");
    } finally {
      setSending(false);
    }
  };

  // Troca de conversa: descarta qualquer gravação em andamento.
  useEffect(() => {
    setAudioError(null);
    return () => discardRef.current();
  }, [conversationId]);

  const handleSendAudio = async () => {
    setAudioError(null);
    if (recordingOwnerRef.current !== conversationId) {
      recordingOwnerRef.current = null;
      recorder.discard();
      setAudioError("Esta gravação é de outra conversa. Descarte e grave de novo.");
      return;
    }
    try {
      await recorder.send(async (blob, seconds) => {
        const formData = new FormData();
        formData.append("conversation_id", conversationId);
        const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
        // A API para de ler campos no primeiro arquivo: duration_seconds precisa vir ANTES de "audio".
        formData.append("duration_seconds", String(seconds));
        formData.append("audio", blob, `audio.${ext}`);
        await apiFetch("/messages/send-audio", { method: "POST", body: formData });
      });
      fetchConversation();
      onConversationChanged?.();
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : "Erro ao enviar áudio");
    }
  };

  // Layout WhatsApp: a barra de áudio vai no slot extraActions do composer (ocioso)
  // ou ocupa a linha inteira (gravando/revisando/enviando).
  const recorderBar = waLayout && audioEnabled ? (
    <AudioRecorderBar
      phase={recorder.phase}
      seconds={recorder.seconds}
      error={recorder.error}
      canSend={recorder.canSend}
      previewUrl={recorder.previewUrl}
      uploadError={audioError}
      onStart={() => { setAudioError(null); recordingOwnerRef.current = conversationId; recorder.start(); }}
      onStop={recorder.stop}
      onDiscard={() => { setAudioError(null); recorder.discard(); }}
      onSend={handleSendAudio}
    />
  ) : null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full w-full">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {conversation && (
          <ChatHeader
            compact={compact}
            waLayout={waLayout}
            conversation={conversation}
            onStatusChange={handleStatusChange}
            onTakeoverToggle={handleTakeoverToggle}
            onDisableAi={handleDisableAi}
            onReenableAi={handleReenableAi}
            onUpdate={fetchConversation}
            onOpenDetails={() => setDetailsOpen(true)}
            onClose={onClose ?? (() => {
              // Volta no histórico quando veio da própria lista; senão, abre a lista.
              if (window.history.length > 1 && document.referrer.startsWith(window.location.origin)) router.back();
              else router.push("/inbox");
            })}
          />
        )}

        {/* Messages */}
        <div ref={scrollRef} className={waLayout ? cn("min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 md:px-[5%] xl:px-[7%]", WA_THEME.chatBg) : "min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3 md:p-4"}>
          {messages.map((msg, i) => {
            // Separador de dia, como no WhatsApp: aparece quando o dia da mensagem muda em relação à anterior.
            const newDay = i === 0 || chatDayKey(messages[i - 1].created_at) !== chatDayKey(msg.created_at);
            if (waLayout) {
              const tail = startsBubbleGroup(messages[i - 1], msg);
              return (
                <div key={msg.id} className={cn("space-y-2", tail ? "pt-2" : "pt-0.5")}>
                  {newDay && (
                    <div className="sticky top-0 z-10 flex justify-center py-1">
                      <span className={cn("rounded-lg px-3 py-1.5 text-xs font-medium shadow-sm", WA_THEME.dayPill)}>{chatDayLabel(msg.created_at, new Date().toISOString())}</span>
                    </div>
                  )}
                  <MessageBubble message={msg} waLayout tail={tail} />
                </div>
              );
            }
            return (
              <div key={msg.id} className="space-y-3">
                {newDay && (
                  <div className="sticky top-0 z-10 flex justify-center py-1">
                    <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">{chatDayLabel(msg.created_at, new Date().toISOString())}</span>
                  </div>
                )}
                <MessageBubble message={msg} />
              </div>
            );
          })}
        </div>

        {/* Notice + Input */}
        <div className={waLayout ? cn("shrink-0 border-t", WA_THEME.header, WA_THEME.divider) : "shrink-0 border-t"}>
          {conversation && !conversation.is_human_takeover && !conversation.wa_contacts?.ai_disabled && (
            <div className="border-b bg-destructive/10 px-3 py-2 md:px-4 text-xs text-destructive">
              O agente está atendendo. Enviar uma mensagem atribui a conversa a você e pausa o agente e as automações.
            </div>
          )}
          {waLayout ? (
          <div className="relative flex items-end gap-2 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-4">
            {recorderBusy ? recorderBar : (
              <MessageComposer
                value={input}
                onChange={setInput}
                onSend={handleSend}
                sending={sending}
                placeholder="Digite uma mensagem"
                extraActions={recorderBar ?? undefined}
              />
            )}
          </div>
          ) : (
          <div className="relative flex items-center gap-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:p-4">
            {!recorderBusy && (
              <>
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Digite uma mensagem..."
                  disabled={sending}
                  className="h-11 rounded-full md:h-8"
                />
                <Button
                  onClick={handleSend}
                  disabled={sending || !input.trim()}
                  size="icon"
                  className="size-11 shrink-0 rounded-full md:size-8"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </>
            )}
            {audioEnabled && (
              <AudioRecorderBar
                phase={recorder.phase}
                seconds={recorder.seconds}
                error={recorder.error}
                canSend={recorder.canSend}
                previewUrl={recorder.previewUrl}
                uploadError={audioError}
                onStart={() => { setAudioError(null); recordingOwnerRef.current = conversationId; recorder.start(); }}
                onStop={recorder.stop}
                onDiscard={() => { setAudioError(null); recorder.discard(); }}
                onSend={handleSendAudio}
              />
            )}
          </div>
          )}
        </div>
      </div>

      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent className="data-[side=right]:w-full sm:data-[side=right]:w-3/4">
          <SheetHeader>
            <SheetTitle>Detalhes da conversa</SheetTitle>
          </SheetHeader>
          {conversation && <SidePanel conversation={conversation} onUpdate={fetchConversation} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
