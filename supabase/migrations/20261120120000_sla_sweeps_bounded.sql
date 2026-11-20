-- Varreduras de SLA limitadas: a espera da primeira resposta (awaiting_first_response) é encerrada quando a resposta é CONFIRMADA,
-- e a cobrança de atribuições assumidas só olha os últimos 5 dias. Mais um índice por conversa em lead_assignments.
--
-- DEPENDE de 20261119130000, 20261119140000 e 20261119150000 (reaplicação de #110–#115 depois da volta de 20/11).
--
-- Por quê: flag_sla_alerts roda a cada minuto e reavalia toda atribuição 'accepted' com awaiting_first_response = true e sla_breached = false.
-- A coluna era ligada no Assumir/1ª mensagem do painel e NUNCA desligada: a lista crescia para sempre, e cada linha passa por
-- _awaiting_first_response (que lê messages, ligações, tarefas, notas...). Com o volume de hoje (≈600 atribuições) é barato, mas cresce sem limite.
--
-- O que muda (nenhuma decisão de negócio muda):
--   1. awaiting_first_response := false quando há mensagem humana CONFIRMADA (id do WhatsApp, sem falha) do vendedor ou de autor desconhecido
--      desde a atribuição. Mensagem em voo, com falha ou de OUTRO autor (ex.: o gestor) não encerra. É exatamente o caso em que todas as regras
--      (_awaiting_first_response, escalada, push "SLA estourado") já davam a espera por encerrada: só deixa de ser recalculado.
--   2. awaiting_first_response := false quando o prazo venceu há mais de 5 dias (a escalada já ignora > 5 dias; o push, > 24 h).
--   3. flag_sla_alerts: para 'accepted', só prazos dos últimos 5 dias. 'pending' continua exatamente como antes.
--   4. Índice lead_assignments(conversation_id, assigned_at): as regras buscam atribuições da mesma conversa (período do vendedor, devolução).
-- Reverter: recriar flag_sla_alerts de 20261119130000; o índice pode ficar (ou DROP INDEX public.lead_assignments_conversation).
-- NÃO aplicada automaticamente.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS lead_assignments_conversation ON public.lead_assignments (conversation_id, assigned_at);

CREATE OR REPLACE FUNCTION public.flag_sla_alerts() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  -- 1. Espera respondida com mensagem confirmada do vendedor (ou de autoria desconhecida): encerra de vez.
  UPDATE public.lead_assignments a SET awaiting_first_response = false
   WHERE a.status = 'accepted' AND a.awaiting_first_response
     AND public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at, (SELECT r.user_id FROM public.sales_reps r WHERE r.id = a.rep_id));
  -- 2. Espera esquecida (prazo vencido há mais de 5 dias): sai do acompanhamento.
  UPDATE public.lead_assignments SET awaiting_first_response = false
   WHERE status = 'accepted' AND awaiting_first_response AND sla_due_at < now() - interval '5 days';
  -- 3. Cobrança (igual à 20261119130000; 'accepted' só nos últimos 5 dias).
  UPDATE public.lead_assignments SET sla_breached = true
   WHERE sla_action = 'alert' AND sla_due_at <= now() AND NOT sla_breached
     AND (status = 'pending' OR (status = 'accepted' AND awaiting_first_response AND sla_due_at >= now() - interval '5 days'))
     AND public._awaiting_first_response(lead_assignments);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.flag_sla_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_sla_alerts() TO service_role;
