import { getOrganizationById, type getAdminClient } from "@aula-agente/database";

type AdminClient = ReturnType<typeof getAdminClient>;

/** Janela em que um retorno logo após atendimento humano mantém o humano no comando (a MarIAna não assume sozinha). */
export const RETURN_HUMAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OWNER_LOOKBACK_DAYS = 30;

export interface ReturningCustomerOwnership {
  /** auth.users.id do vendedor que continua responsável pelo cliente. */
  assignedTo: string;
  /** true: retorno até 24 h depois de atendimento humano → nasce em takeover (regras normais de timeout continuam valendo). */
  keepHumanTakeover: boolean;
}

export interface PreviousConversationRef {
  id: string;
}

/** Acesso a dados isolado para testar a regra sem banco. */
export interface ReturningCustomerDeps {
  getOwnerLookbackDays(organizationId: string): Promise<number>;
  getPreviousConversation(organizationId: string, contactId: string): Promise<PreviousConversationRef | null>;
  /** Reaproveita a regra oficial do rodízio (resolve_current_owner): negócio aberto > conversa anterior > último aceite na janela. */
  resolveCurrentOwner(args: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    lookbackDays: number;
  }): Promise<{ repId: string | null; outcome: string }>;
  getRepUserId(organizationId: string, repId: string): Promise<string | null>;
  getLastHumanMessageAt(conversationId: string): Promise<Date | null>;
}

/**
 * Decide quem deve ficar com um cliente que volta e abre uma conversa nova (a anterior foi resolvida/fechada).
 * Devolve null (comportamento antigo: conversa nova sem dono) quando não há conversa anterior ou o vínculo não vale mais:
 * vendedor desligado/ausente (`out`), fora da organização (`invalid`), sem cadastro de vendedor, conflito entre negócios,
 * ou gestor que já redistribuiu (o dono do negócio aberto prevalece sobre o da conversa anterior).
 * Nunca lança: qualquer falha vira null para não atrasar nem impedir o atendimento.
 */
export async function resolveReturningCustomerOwnership(
  deps: ReturningCustomerDeps,
  params: { organizationId: string; contactId: string; now?: Date },
): Promise<ReturningCustomerOwnership | null> {
  try {
    const now = params.now ?? new Date();
    const previous = await deps.getPreviousConversation(params.organizationId, params.contactId);
    if (!previous) return null;

    const lookbackDays = await deps.getOwnerLookbackDays(params.organizationId);
    const owner = await deps.resolveCurrentOwner({
      organizationId: params.organizationId,
      contactId: params.contactId,
      conversationId: previous.id,
      lookbackDays,
    });
    if (owner.outcome !== "found" || !owner.repId) return null;

    const userId = await deps.getRepUserId(params.organizationId, owner.repId);
    if (!userId) return null;

    const lastHumanAt = await deps.getLastHumanMessageAt(previous.id);
    const keepHumanTakeover = lastHumanAt !== null && now.getTime() - lastHumanAt.getTime() <= RETURN_HUMAN_WINDOW_MS;
    return { assignedTo: userId, keepHumanTakeover };
  } catch (err) {
    console.error("returning-customer: falha ao resolver responsável anterior; segue sem herdar", err);
    return null;
  }
}

/** Implementação real sobre o Supabase (cliente admin). */
export function createReturningCustomerDeps(db: AdminClient): ReturningCustomerDeps {
  return {
    async getOwnerLookbackDays(organizationId) {
      const org = await getOrganizationById(db, organizationId);
      const days = org.settings?.owner_lookback_days;
      return typeof days === "number" && days > 0 ? days : DEFAULT_OWNER_LOOKBACK_DAYS;
    },
    async getPreviousConversation(organizationId, contactId) {
      const { data, error } = await db
        .from("conversations")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as PreviousConversationRef | null) ?? null;
    },
    async resolveCurrentOwner({ organizationId, contactId, conversationId, lookbackDays }) {
      const { data, error } = await db.rpc("resolve_current_owner", {
        p_org: organizationId,
        p_contact: contactId,
        p_conversation: conversationId,
        p_lookback_days: lookbackDays,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as { rep_id: string | null; outcome: string } | null | undefined;
      return { repId: row?.rep_id ?? null, outcome: row?.outcome ?? "none" };
    },
    async getRepUserId(organizationId, repId) {
      const { data, error } = await db
        .from("sales_reps")
        .select("user_id")
        .eq("organization_id", organizationId)
        .eq("id", repId)
        .maybeSingle();
      if (error) throw error;
      return (data as { user_id: string } | null)?.user_id ?? null;
    },
    async getLastHumanMessageAt(conversationId) {
      const { data, error } = await db
        .from("messages")
        .select("created_at")
        .eq("conversation_id", conversationId)
        .eq("role", "human_agent")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const at = (data as { created_at: string } | null)?.created_at;
      return at ? new Date(at) : null;
    },
  };
}
