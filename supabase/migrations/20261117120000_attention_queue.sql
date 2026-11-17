-- "Precisam de resposta": fila de atendimento da tela inicial (somente leitura).
-- Duas listas: cliente aguardando resposta humana e lead sem primeiro atendimento.
--
-- NÃO ALTERA DADOS. Só cria uma função STABLE; nenhuma tabela, índice, coluna, dono ou rodízio é tocado.
-- Idempotente. Rollback: DROP FUNCTION IF EXISTS public.attention_queue_candidates(uuid, timestamptz, integer, uuid);
--
-- Cuidado com I/O (o projeto já recebeu aviso de Disk IO): a função só lê conversas recentes (índice
-- idx_conversations_org_last_msg) e, por conversa, usa o índice idx_messages_conversation
-- (conversation_id, created_at). Nunca varre `messages` inteira. p_limit limita cada lista.
--
-- Regras (as mesmas da fila na API; ver packages/shared/src/attention-queue.ts):
--  * só mensagem com role 'human_agent' conta como atendimento humano; 'agent' (IA, follow-up automático) e 'system' não contam;
--  * atendimento humano = mensagem human_agent COM envio aceito pela Evolution (evolution_message_id preenchido) e SEM metadata.send_failed_at.
--    A linha que o CRM cria ao enfileirar o envio nasce com evolution_message_id nulo (o worker grava o id depois que a Evolution aceita;
--    a resposta enviada pelo celular chega já com o id). Mensagem pendente, sem confirmação, ou que falhou NÃO conta como resposta.
--    Pelo mesmo motivo a fila NÃO usa lead_assignments.first_human_message_at / status 'accepted' como prova de atendimento:
--    o painel grava esses marcos ao ENFILEIRAR, antes do envio;
--  * o cliente sai da fila quando existe resposta humana POSTERIOR à última mensagem dele (waiting_since só considera
--    mensagens do cliente depois da última resposta humana);
--  * conversa com dono (assigned_to) entra mesmo sem takeover, sem tarefa e sem negócio; sem dono só entra com takeover
--    ligado (sem dono e sem takeover é conversa da IA, não de vendedor).
-- Janela: as DUAS categorias respeitam p_since (awaiting: c.last_message_at e mensagens do cliente; new_lead: la.handoff_at).
-- kind_total: count(*) OVER () calculado antes do LIMIT, igual em todas as linhas da categoria; a API compara com as linhas devolvidas
-- e marca a lista como parcial (contadores "pelo menos") quando p_limit cortou casos.
-- p_owner: quando informado (vendedor), só devolve o que é DELE (mesma regra de visibilidade da API: dono = p_owner); NULL = tudo (gestor).
CREATE OR REPLACE FUNCTION public.attention_queue_candidates(p_org uuid, p_since timestamptz, p_limit integer DEFAULT 200, p_owner uuid DEFAULT NULL)
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
  unanswered_contents text[],
  kind_total bigint             -- total de casos desta categoria na janela ANTES do limite (p_limit); permite detectar lista truncada
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  (
    SELECT 'awaiting'::text, c.id, c.contact_id, w.name, w.phone, c.assigned_to, c.is_human_takeover,
           u.waiting_since, u.last_contact_at, (h.created_at IS NOT NULL), u.contents, count(*) OVER ()
    FROM public.conversations c
    JOIN public.wa_contacts w ON w.id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT m.created_at FROM public.messages m
      WHERE m.conversation_id = c.id AND m.role = 'human_agent' AND m.evolution_message_id IS NOT NULL AND coalesce(m.metadata->>'send_failed_at', '') = ''
      ORDER BY m.created_at DESC LIMIT 1
    ) h ON true
    CROSS JOIN LATERAL (
      SELECT min(m.created_at) AS waiting_since, max(m.created_at) AS last_contact_at,
             (array_agg(left(m.content, 200) ORDER BY m.created_at DESC))[1:5] AS contents
      FROM public.messages m
      -- dois limites inferiores sobre a MESMA coluna (sem OR) para o índice (conversation_id, created_at) ler só o que veio depois da última resposta humana
      WHERE m.conversation_id = c.id AND m.role = 'contact' AND m.created_at >= p_since
        AND m.created_at > coalesce(h.created_at, '-infinity'::timestamptz)
    ) u
    WHERE c.organization_id = p_org AND c.status IN ('open', 'waiting') AND c.last_message_at >= p_since
      AND u.waiting_since IS NOT NULL
      AND (c.assigned_to IS NOT NULL OR c.is_human_takeover)
      AND (p_owner IS NULL OR c.assigned_to = p_owner)
    ORDER BY u.waiting_since ASC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT 'new_lead'::text, la.conversation_id, la.contact_id, w.name, w.phone, sr.user_id, c.is_human_takeover,
           la.handoff_at, la.handoff_at, false, ARRAY[]::text[], count(*) OVER ()
    FROM public.lead_assignments la
    JOIN public.conversations c ON c.id = la.conversation_id
    JOIN public.wa_contacts w ON w.id = la.contact_id
    LEFT JOIN public.sales_reps sr ON sr.id = la.rep_id
    -- LATERAL ... LIMIT 1: uma sondagem por atribuição pelo índice (conversation_id, created_at); nunca varre `messages` inteira
    LEFT JOIN LATERAL (
      SELECT 1 AS ok FROM public.messages m
      WHERE m.conversation_id = la.conversation_id AND m.role = 'human_agent' AND m.created_at >= la.assigned_at
        AND m.evolution_message_id IS NOT NULL AND coalesce(m.metadata->>'send_failed_at', '') = ''
      LIMIT 1
    ) conf ON true
    WHERE la.organization_id = p_org
      -- mesma janela da outra lista: a espera mostrada na tela conta desde handoff_at, então só entra o que chegou dentro de p_since
      AND la.handoff_at >= p_since
      AND (p_owner IS NULL OR sr.user_id = p_owner)
      -- atribuição ativa sem atendimento: pendente, exceção sem resolver, ou aceita PELA MENSAGEM (first_message/phone_echo), cujo aceite foi gravado ao
      -- enfileirar e só vale se o envio for confirmado (abaixo). Aceita pelo botão/admin continua fora da fila (sem mudança de regra).
      AND (la.status = 'pending' OR (la.status = 'exception' AND la.resolved_at IS NULL)
           OR (la.status = 'accepted' AND la.accepted_via IN ('first_message', 'phone_echo')))
      -- sai da fila só com resposta humana CONFIRMADA (aceita pela Evolution, sem falha) depois da atribuição (conf, acima); first_human_message_at sozinho não prova envio
      AND conf.ok IS NULL
    ORDER BY la.handoff_at ASC
    LIMIT p_limit
  );
$$;

REVOKE ALL ON FUNCTION public.attention_queue_candidates(uuid, timestamptz, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attention_queue_candidates(uuid, timestamptz, integer, uuid) TO service_role;
