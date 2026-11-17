-- "Precisam de resposta": fila de atendimento da tela inicial (somente leitura).
-- Duas listas: cliente aguardando resposta humana e lead sem primeiro atendimento.
--
-- NÃO ALTERA DADOS. Só cria uma função STABLE; nenhuma tabela, índice, coluna, dono ou rodízio é tocado.
-- Idempotente. Rollback: DROP FUNCTION IF EXISTS public.attention_queue_candidates(uuid, timestamptz, integer);
--
-- Cuidado com I/O (o projeto já recebeu aviso de Disk IO): a função só lê conversas recentes (índice
-- idx_conversations_org_last_msg) e, por conversa, usa o índice idx_messages_conversation
-- (conversation_id, created_at). Nunca varre `messages` inteira. p_limit limita cada lista.
--
-- Regras (as mesmas da fila na API; ver packages/shared/src/attention-queue.ts):
--  * só mensagem com role 'human_agent' conta como atendimento humano; 'agent' (IA, follow-up automático) e 'system' não contam;
--  * mensagem humana que falhou no envio (metadata.send_failed_at) NÃO conta como resposta;
--  * o cliente sai da fila quando existe resposta humana POSTERIOR à última mensagem dele (waiting_since só considera
--    mensagens do cliente depois da última resposta humana);
--  * conversa com dono (assigned_to) entra mesmo sem takeover, sem tarefa e sem negócio; sem dono só entra com takeover
--    ligado (sem dono e sem takeover é conversa da IA, não de vendedor).
CREATE OR REPLACE FUNCTION public.attention_queue_candidates(p_org uuid, p_since timestamptz, p_limit integer DEFAULT 200)
RETURNS TABLE (
  kind text,                    -- 'awaiting' | 'new_lead'
  conversation_id uuid,
  contact_id uuid,
  contact_name text,
  contact_phone text,
  owner_user_id uuid,
  is_human_takeover boolean,
  waiting_since timestamptz,
  last_contact_at timestamptz,
  had_human_reply boolean,
  unanswered_contents text[]
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  (
    SELECT 'awaiting'::text, c.id, c.contact_id, w.name, w.phone, c.assigned_to, c.is_human_takeover,
           u.waiting_since, u.last_contact_at, (h.created_at IS NOT NULL), u.contents
    FROM public.conversations c
    JOIN public.wa_contacts w ON w.id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT m.created_at FROM public.messages m
      WHERE m.conversation_id = c.id AND m.role = 'human_agent' AND coalesce(m.metadata->>'send_failed_at', '') = ''
      ORDER BY m.created_at DESC LIMIT 1
    ) h ON true
    CROSS JOIN LATERAL (
      SELECT min(m.created_at) AS waiting_since, max(m.created_at) AS last_contact_at,
             (array_agg(left(m.content, 200) ORDER BY m.created_at DESC))[1:5] AS contents
      FROM public.messages m
      WHERE m.conversation_id = c.id AND m.role = 'contact' AND m.created_at >= p_since
        AND (h.created_at IS NULL OR m.created_at > h.created_at)
    ) u
    WHERE c.organization_id = p_org AND c.status IN ('open', 'waiting') AND c.last_message_at >= p_since
      AND u.waiting_since IS NOT NULL
      AND (c.assigned_to IS NOT NULL OR c.is_human_takeover)
    ORDER BY u.waiting_since ASC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT 'new_lead'::text, la.conversation_id, la.contact_id, w.name, w.phone, sr.user_id, c.is_human_takeover,
           la.handoff_at, la.handoff_at, false, ARRAY[]::text[]
    FROM public.lead_assignments la
    JOIN public.conversations c ON c.id = la.conversation_id
    JOIN public.wa_contacts w ON w.id = la.contact_id
    LEFT JOIN public.sales_reps sr ON sr.id = la.rep_id
    WHERE la.organization_id = p_org AND la.first_human_message_at IS NULL
      AND (la.status = 'pending' OR (la.status = 'exception' AND la.resolved_at IS NULL))
      -- o campo first_human_message_at pode atrasar: uma resposta humana (que enviou) depois da atribuição também tira o lead da fila
      AND NOT EXISTS (
        SELECT 1 FROM public.messages m
        WHERE m.conversation_id = la.conversation_id AND m.role = 'human_agent' AND m.created_at >= la.assigned_at
          AND coalesce(m.metadata->>'send_failed_at', '') = ''
      )
    ORDER BY la.handoff_at ASC
    LIMIT p_limit
  );
$$;

REVOKE ALL ON FUNCTION public.attention_queue_candidates(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attention_queue_candidates(uuid, timestamptz, integer) TO service_role;
