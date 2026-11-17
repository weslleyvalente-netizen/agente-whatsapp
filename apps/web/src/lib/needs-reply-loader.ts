import { isNeedsReplyQueueEnabledFor } from "@aula-agente/shared";
import type { NeedsReplyData } from "@/components/dashboard/needs-reply-panel";

type Fetcher = (path: string) => Promise<unknown>;

/**
 * Busca a fila "Precisam de resposta" só quando vale a pena: flag da organização ligada E usuário no piloto
 * (needs_reply_queue_user_ids). Fora disso NÃO faz chamada nenhuma e devolve null (a tela mantém "Tarefas urgentes").
 * O backend confere de novo; esta checagem só evita a chamada e a leitura da organização à toa.
 * Quem chama executa a cada montagem da tela (inclusive ao voltar de uma conversa), sem polling.
 */
export async function loadNeedsReply(
  org: { id: string; settings?: unknown } | null | undefined,
  userId: string | null | undefined,
  fetcher: Fetcher,
): Promise<NeedsReplyData | null> {
  if (!org || !isNeedsReplyQueueEnabledFor(org.settings as Parameters<typeof isNeedsReplyQueueEnabledFor>[0], userId)) return null;
  try {
    const data = (await fetcher(`/organizations/${org.id}/dashboard/needs-reply`)) as { enabled?: boolean } | null;
    return data?.enabled === true ? (data as NeedsReplyData) : null;
  } catch {
    return null;
  }
}
