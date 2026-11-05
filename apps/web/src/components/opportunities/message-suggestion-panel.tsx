"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, MessageSquareShare, RefreshCw, Sparkles, X } from "lucide-react";
import { MESSAGE_SUGGESTION_MODES, MESSAGE_SUGGESTION_MODE_LABELS, type MessageSuggestionMode } from "@aula-agente/shared";
import { apiFetch } from "@/lib/api";
import { suggestionErrorMessage } from "@/lib/message-suggestion";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// Painel "Sugerir mensagem": a IA propõe o texto, a vendedora edita e decide. Nada é enviado daqui — "Usar no chat" só preenche o campo.
export function MessageSuggestionPanel({ opportunityId, initialMode, onUseInChat, onClose }: {
  opportunityId: string; initialMode: MessageSuggestionMode; onUseInChat?: (text: string) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState<MessageSuggestionMode>(initialMode);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const seq = useRef(0);

  const generate = useCallback(async (nextMode: MessageSuggestionMode, previous?: string) => {
    const mine = ++seq.current;
    setLoading(true); setError(null); setCopied(false);
    try {
      const r = await apiFetch(`/opportunities/${opportunityId}/message-suggestion`, { method: "POST", body: JSON.stringify({ mode: nextMode, ...(previous ? { regenerate: true, previousMessage: previous } : {}) }) });
      if (mine === seq.current) setText(r.message);
    } catch (err) {
      if (mine === seq.current) setError(suggestionErrorMessage(err as { status?: number; message?: string }));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [opportunityId]);

  // Gera uma vez ao abrir: o modo inicial não entra nas dependências (recarregar a lista não pode refazer a sugestão nem gastar o limite).
  useEffect(() => { generate(initialMode); return () => { seq.current++; }; }, [generate]); // eslint-disable-line react-hooks/exhaustive-deps

  function changeMode(next: MessageSuggestionMode) { if (next === mode || loading) return; setMode(next); setText(""); generate(next); }
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setError("Não foi possível copiar. Selecione o texto e copie manualmente."); } }

  return <section aria-label="Sugerir mensagem" className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:p-4">
    <div className="flex items-start justify-between gap-2">
      <h3 className="flex items-center gap-2 font-medium"><Sparkles className="size-4" aria-hidden />Sugerir mensagem</h3>
      <Button size="icon-sm" variant="ghost" aria-label="Fechar sugestão" onClick={onClose}><X aria-hidden /></Button>
    </div>
    <div role="radiogroup" aria-label="Tipo de mensagem" className="grid grid-cols-2 gap-2 sm:flex">
      {MESSAGE_SUGGESTION_MODES.map(m => <Button key={m} role="radio" aria-checked={m === mode} size="sm" className="max-md:h-10" variant={m === mode ? "default" : "outline"} disabled={loading && m !== mode} onClick={() => changeMode(m)}>{MESSAGE_SUGGESTION_MODE_LABELS[m]}</Button>)}
    </div>
    {loading && <p role="status" className="text-sm text-muted-foreground">Gerando sugestão pelo contexto da conversa…</p>}
    {error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p><Button size="sm" variant="outline" className="max-md:h-10" onClick={() => generate(mode, text || undefined)}>Tentar de novo</Button></div>}
    {text && !loading && <>
      <label className="block text-sm">Mensagem sugerida (edite antes de usar)<Textarea className="mt-1 min-h-28" value={text} onChange={e => { setText(e.target.value); setCopied(false); }} /></label>
      <p className="text-xs text-muted-foreground">Nada é enviado automaticamente. Revise e envie você mesma.</p>
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        <Button size="sm" variant="outline" className="max-md:h-10" onClick={copy}><Copy aria-hidden />{copied ? "Copiado" : "Copiar"}</Button>
        <Button size="sm" variant="outline" className="max-md:h-10" onClick={() => generate(mode, text)}><RefreshCw aria-hidden />Gerar outra</Button>
        {onUseInChat && <Button size="sm" className="max-md:h-10" disabled={!text.trim()} onClick={() => onUseInChat(text)}><MessageSquareShare aria-hidden />Usar no chat</Button>}
      </div>
    </>}
  </section>;
}
