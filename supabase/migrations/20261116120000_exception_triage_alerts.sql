-- P0a: triagem de exceções de SLA + alertas 0/15/30/60 min úteis. SOMENTE objetos NOVOS (nenhuma coluna, linha ou função existente é alterada).
-- NÃO aplicada automaticamente: revisar, ensaiar em cópia e só então aplicar com autorização. A funcionalidade nasce DESLIGADA:
--   organizations.settings.exception_alerts_mode (ausente = off), exception_alerts_activated_at, exception_triage_panel_enabled.
--
-- O que NÃO faz: não toca lead_assignments, lead_distribution_state, sales_reps.rotation_order, conversas, negócios ou tarefas.
-- "Resolver" uma exceção aqui é só um REGISTRO (exception_events); o histórico original (handoff, SLA, responsável) fica intacto.
--
-- Segurança: as três tabelas têm RLS LIGADA e NENHUMA policy => vendedor/anon (JWT do navegador) não lê nem escreve nada;
--   só a service role (API/worker). Os DESTINATÁRIOS dos alertas ficam em exception_alert_recipients e NÃO em organizations.settings,
--   porque a policy org_select deixa qualquer membro da organização ler settings inteiro.
--
-- ROLLBACK (só objetos desta migração; nenhum dado de negócio é afetado):
--   drop function if exists public.record_exception_event(uuid, uuid, text, uuid, text, uuid);
--   drop table if exists public.exception_alert_ledger;
--   drop table if exists public.exception_events;
--   drop table if exists public.exception_alert_recipients;
--   drop function if exists public.exception_events_append_only();
-- Rollback operacional imediato (sem SQL): settings.exception_alerts_mode = 'off' e exception_triage_panel_enabled = false (efeito em 1 ciclo).

-- 1) Eventos de reconhecimento/resolução: APPEND-ONLY e auditáveis.
CREATE TABLE IF NOT EXISTS public.exception_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- id da linha lead_assignments com status 'exception' (sem FK de propósito: o registro de auditoria sobrevive a qualquer limpeza futura).
  assignment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('acknowledged', 'resolved_confirmed', 'resolved_no_action')),
  actor_user_id uuid NOT NULL,
  -- vendedor que de fato assumiu (obrigatório em resolved_confirmed; informado pelo gestor).
  rep_id uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exception_events_confirmed_needs_rep CHECK (kind <> 'resolved_confirmed' OR rep_id IS NOT NULL),
  CONSTRAINT exception_events_no_action_needs_note CHECK (kind <> 'resolved_no_action' OR length(btrim(coalesce(note, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS exception_events_assignment ON public.exception_events (assignment_id, created_at);
-- No máximo UMA resolução por exceção (idempotência sob concorrência).
CREATE UNIQUE INDEX IF NOT EXISTS exception_events_one_resolution ON public.exception_events (assignment_id) WHERE kind LIKE 'resolved\_%';

-- Append-only: UPDATE nunca; DELETE só dentro de cascata de FK (exclusão da organização).
CREATE OR REPLACE FUNCTION public.exception_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'exception_events é somente de inserção';
END $$;
DROP TRIGGER IF EXISTS exception_events_no_update ON public.exception_events;
CREATE TRIGGER exception_events_no_update BEFORE UPDATE OR DELETE ON public.exception_events FOR EACH ROW EXECUTE FUNCTION public.exception_events_append_only();

-- 2) Livro de alertas: uma linha por (exceção, estágio, canal, destinatário). O índice único é a autoridade contra duplicação.
CREATE TABLE IF NOT EXISTS public.exception_alert_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  stage smallint NOT NULL CHECK (stage IN (0, 15, 30, 60)),
  -- 'shadow' = registrado sem enviar; 'skipped' = estágio vencido que ficou para trás (worker parado) ou sem aparelho.
  channel text NOT NULL CHECK (channel IN ('push', 'email', 'shadow', 'skipped')),
  recipient_user_id uuid,
  mode text NOT NULL CHECK (mode IN ('shadow', 'on')),
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'skipped')),
  -- só metadados operacionais (estágio, atraso, motivo): NUNCA nome, telefone ou texto de cliente.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS exception_alert_ledger_unique
  ON public.exception_alert_ledger (assignment_id, stage, channel, coalesce(recipient_user_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS exception_alert_ledger_org_time ON public.exception_alert_ledger (organization_id, created_at DESC);

-- 3) Destinatários explícitos (gestores). Sem linha = ninguém além dos vendedores recebe; NUNCA cai em "todos os owners/admins"
--    (o login compartilhado da loja não deve receber alerta de gestão).
CREATE TABLE IF NOT EXISTS public.exception_alert_recipients (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (organization_id, user_id)
);

ALTER TABLE public.exception_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exception_alert_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exception_alert_recipients ENABLE ROW LEVEL SECURITY;
-- Sem policies de propósito. Revogação explícita para não depender só da RLS.
REVOKE ALL ON public.exception_events, public.exception_alert_ledger, public.exception_alert_recipients FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exception_events, public.exception_alert_ledger, public.exception_alert_recipients TO service_role;

-- 4) Registro atômico e idempotente de reconhecimento/resolução.
-- Trava SÓ a linha da exceção (nenhum outro lock => sem ciclo com distribute_lead/redistribute_assignment/manual_assign, que travam
-- lead_distribution_state primeiro e a linha depois). Não altera lead_assignments.
CREATE OR REPLACE FUNCTION public.record_exception_event(
  p_organization_id uuid, p_assignment_id uuid, p_kind text, p_actor uuid, p_note text DEFAULT NULL, p_rep_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; existing public.exception_events; new_id uuid;
BEGIN
  IF p_kind NOT IN ('acknowledged', 'resolved_confirmed', 'resolved_no_action') THEN RAISE EXCEPTION 'Tipo de evento inválido'; END IF;
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id AND organization_id = p_organization_id FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Exceção inexistente'; END IF;
  IF a.status <> 'exception' THEN RAISE EXCEPTION 'A atribuição não é uma exceção'; END IF;
  IF a.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'A exceção já foi encerrada por outro caminho'; END IF;

  SELECT * INTO existing FROM public.exception_events WHERE assignment_id = p_assignment_id AND kind LIKE 'resolved\_%' LIMIT 1;
  IF existing.id IS NOT NULL THEN
    -- Resolver de novo com o mesmo tipo é idempotente; tipo diferente é conflito (não reescreve a decisão anterior).
    IF p_kind = existing.kind THEN RETURN existing.id; END IF;
    RAISE EXCEPTION 'A exceção já foi resolvida';
  END IF;

  IF p_kind = 'resolved_confirmed' THEN
    IF p_rep_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.id = p_rep_id AND r.organization_id = p_organization_id) THEN
      RAISE EXCEPTION 'Informe o vendedor que assumiu';
    END IF;
  END IF;
  IF p_kind = 'resolved_no_action' AND length(btrim(coalesce(p_note, ''))) = 0 THEN RAISE EXCEPTION 'Informe o motivo'; END IF;

  INSERT INTO public.exception_events (organization_id, assignment_id, kind, actor_user_id, rep_id, note)
  VALUES (p_organization_id, p_assignment_id, p_kind, p_actor, CASE WHEN p_kind = 'resolved_confirmed' THEN p_rep_id END, nullif(btrim(coalesce(p_note, '')), ''))
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION public.record_exception_event(uuid, uuid, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_exception_event(uuid, uuid, text, uuid, text, uuid) TO service_role;
