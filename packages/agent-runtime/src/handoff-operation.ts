// Produto do card de encaminhamento: lê a conversa recente (14 dias) e o anúncio de origem e aplica inferHandoffOperation.
// Nunca derruba o encaminhamento: qualquer falha => null (sem operação e sem marca administrativa: o card é criado como antes).
import { getRecentMessages, getLatestAdTouchText, type SupabaseClient } from "@aula-agente/database";
import { ATTRIBUTION_WINDOW_MS, inferHandoffOperation, type HandoffOperationResult } from "@aula-agente/shared";

const CONTEXT_DAYS = 14;

export async function classifyHandoffOperation(db: SupabaseClient, p: { organizationId: string; conversationId: string; contactId: string; resumo: string; now?: Date }): Promise<HandoffOperationResult | null> {
  try {
    const now = p.now ?? new Date();
    const since = now.getTime() - CONTEXT_DAYS * 86_400_000;
    const [messages, adText] = await Promise.all([
      getRecentMessages(db, p.conversationId, 40),
      getLatestAdTouchText(db, p.organizationId, p.contactId, new Date(now.getTime() - ATTRIBUTION_WINDOW_MS).toISOString()).catch(() => null),
    ]);
    const recent = (messages ?? []).filter((m: { created_at?: string }) => !m.created_at || Date.parse(m.created_at) >= since);
    const r = inferHandoffOperation({ messages: recent as Array<{ role: string; content: string | null }>, resumo: p.resumo, adText });
    console.log("[handoff-operation]", JSON.stringify({ conversation: p.conversationId, operation: r.operation, source: r.source, confidence: r.confidence, administrative: r.administrative, mixed: r.mixedAdministrative, ad_hint: r.adHint }));
    return r;
  } catch (err) {
    console.error("[handoff-operation] classificação falhou; card fica a confirmar", p.conversationId, err);
    return null;
  }
}
