import type { SupabaseClient } from "@aula-agente/database";
import { extractAdTouch } from "@aula-agente/shared";

export type RecordAdTouchResult = "recorded" | "duplicate" | "skipped";

/**
 * Registra um "toque" de anúncio (tabela lead_ad_touches) a partir do externalAdReply de uma mensagem do cliente.
 * Regras: só grava quando o anúncio difere do último toque do contato (mesma chave: id do anúncio, senão link sem
 * parâmetros, senão título+texto) e o reenvio da mesma mensagem não duplica (índice único por mensagem).
 * A primeira origem do contato (selo do card, metadata.lead_origin) NÃO é tocada aqui. Erros (exceto duplicidade) sobem
 * para o chamador, que os registra sem interromper o recebimento da mensagem.
 */
export async function recordAdTouch(
  db: SupabaseClient,
  p: {
    organizationId: string;
    contactId: string;
    conversationId: string | null;
    evolutionMessageId: string | null;
    touchedAt: Date;
    ad: Record<string, unknown> | null | undefined;
  }
): Promise<RecordAdTouchResult> {
  const touch = extractAdTouch(p.ad);
  if (!touch) return "skipped";

  const { data: latest, error: latestError } = await db
    .from("lead_ad_touches").select("touch_key")
    .eq("organization_id", p.organizationId).eq("contact_id", p.contactId)
    .order("touched_at", { ascending: false }).limit(1).maybeSingle();
  if (latestError) throw latestError;
  if ((latest as { touch_key: string } | null)?.touch_key === touch.touch_key) return "duplicate";

  const at = Number.isFinite(p.touchedAt.getTime()) && p.touchedAt.getTime() <= Date.now() ? p.touchedAt : new Date();
  const { error } = await db.from("lead_ad_touches").insert({
    organization_id: p.organizationId, contact_id: p.contactId, conversation_id: p.conversationId,
    evolution_message_id: p.evolutionMessageId, touched_at: at.toISOString(),
    platform: touch.platform, source_type: touch.source_type,
    ad_id: touch.ad_id, ad_title: touch.ad_title, ad_body: touch.ad_body, ad_url: touch.ad_url, ctwa_clid: touch.ctwa_clid,
    campaign_id: touch.campaign_id, campaign_name: touch.campaign_name,
    touch_key: touch.touch_key, available_fields: touch.available_fields,
  });
  if (error) {
    // Reenvio/recuperação da mesma mensagem: o índice único por mensagem barra, sem ser erro.
    if ((error as { code?: string }).code === "23505") return "duplicate";
    throw error;
  }
  return "recorded";
}
