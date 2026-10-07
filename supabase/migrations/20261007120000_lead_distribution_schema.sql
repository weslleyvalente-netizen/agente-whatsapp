-- supabase/migrations/20261007120000_lead_distribution_schema.sql
-- Distribuição de leads (rodízio): dados, imutabilidade e métricas. Sem efeito enquanto
-- organizations.settings.lead_distribution_enabled não for true.

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS owner_assigned_at timestamptz;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS last_commercial_activity_at timestamptz;

CREATE TABLE public.sales_reps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  display_name text NOT NULL,
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','paused','out')),
  availability_changed_at timestamptz NOT NULL DEFAULT now(),
  rotation_order integer NOT NULL,
  -- Só auditoria: NÃO decide quem é o próximo (isso é lead_distribution_state.last_rotation_order).
  last_assigned_at timestamptz,
  -- Reservados para o futuro; a estratégia atual os ignora.
  weight numeric,
  max_active_leads integer,
  specialties text[] NOT NULL DEFAULT '{}',
  score numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, rotation_order)
);

CREATE TABLE public.lead_distribution_state (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_rotation_order integer NOT NULL DEFAULT 0,
  -- Ponteiro próprio do modo sombra: simula a alternância sem tocar no real.
  shadow_last_rotation_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lead_distribution_shadow_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  handoff_event_id uuid NOT NULL UNIQUE REFERENCES public.handoff_events(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE,
  would_rep_id uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  would_rep_name text,
  reason text NOT NULL,
  exception_reason text,
  pointer_before integer NOT NULL,
  pointer_after integer NOT NULL,
  sla_due_at timestamptz,
  sla_action text,
  handed_at timestamptz NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_distribution_shadow_log_org ON public.lead_distribution_shadow_log (organization_id, created_at DESC);

-- Histórico imutável (sem DELETE): por desenho, apagar organização/agente/instância/contato com histórico de distribuição é bloqueado.
CREATE TABLE public.lead_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  chain_id uuid NOT NULL,
  handoff_event_id uuid NOT NULL REFERENCES public.handoff_events(id),
  contact_id uuid NOT NULL REFERENCES public.wa_contacts(id),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id),
  opportunity_id uuid REFERENCES public.opportunities(id),
  rep_id uuid REFERENCES public.sales_reps(id),
  reason text NOT NULL CHECK (reason IN ('round_robin','existing_owner','sla_redistribution','manual','bulk_reassignment','exception')),
  status text NOT NULL CHECK (status IN ('pending','accepted','expired','redistributed','exception')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  handoff_at timestamptz NOT NULL,
  sla_due_at timestamptz,
  sla_breached boolean NOT NULL DEFAULT false,
  -- 'redistribute': lead novo do rodízio (redistribui ao estourar). 'alert': dono existente ou atribuição manual (só alerta, nunca redistribui).
  sla_action text NOT NULL DEFAULT 'redistribute' CHECK (sla_action IN ('redistribute','alert')),
  redistribution_reason text,
  accepted_at timestamptz,
  accepted_via text CHECK (accepted_via IN ('button','first_message','phone_echo','admin')),
  first_human_message_at timestamptz,
  first_human_message_by uuid,
  previous_assignment_id uuid REFERENCES public.lead_assignments(id),
  next_assignment_id uuid REFERENCES public.lead_assignments(id),
  exception_reason text CHECK (exception_reason IN ('no_available_rep','all_reps_sla_breached','invalid_existing_owner','distribution_error','manual_review')),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution text,
  origin_source text,
  operation text,
  product_model text,
  strategy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'exception') = (rep_id IS NULL)),
  CHECK ((status = 'exception') = (exception_reason IS NOT NULL))
);

-- No máximo uma atribuição ativa por conversa.
CREATE UNIQUE INDEX lead_assignments_one_active_per_conversation ON public.lead_assignments (conversation_id) WHERE status IN ('pending','accepted');
-- Cada vendedor recebe o mesmo handoff no máximo uma vez nas atribuições automáticas (sem vai e volta).
CREATE UNIQUE INDEX lead_assignments_one_rep_per_chain ON public.lead_assignments (chain_id, rep_id) WHERE rep_id IS NOT NULL AND reason IN ('round_robin','existing_owner','sla_redistribution');
-- Idempotência: um handoff abre uma única cadeia.
CREATE UNIQUE INDEX lead_assignments_one_chain_per_handoff ON public.lead_assignments (handoff_event_id) WHERE previous_assignment_id IS NULL;
CREATE INDEX lead_assignments_sla_due ON public.lead_assignments (sla_due_at) WHERE status = 'pending' AND sla_action = 'redistribute';
CREATE INDEX lead_assignments_sla_alert_due ON public.lead_assignments (sla_due_at) WHERE status = 'pending' AND sla_action = 'alert' AND NOT sla_breached;
CREATE INDEX lead_assignments_open_exceptions ON public.lead_assignments (organization_id) WHERE status = 'exception' AND resolved_at IS NULL;
CREATE INDEX lead_assignments_contact ON public.lead_assignments (organization_id, contact_id, assigned_at DESC);

-- Histórico imutável: nunca DELETE; campos de identidade nunca mudam.
CREATE FUNCTION public.lead_assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lead_assignments é imutável: não apague o histórico'; END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
     OR NEW.handoff_event_id IS DISTINCT FROM OLD.handoff_event_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.rep_id IS DISTINCT FROM OLD.rep_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
     OR NEW.handoff_at IS DISTINCT FROM OLD.handoff_at
     OR NEW.previous_assignment_id IS DISTINCT FROM OLD.previous_assignment_id
     OR NEW.strategy_version IS DISTINCT FROM OLD.strategy_version
     OR NEW.sla_action IS DISTINCT FROM OLD.sla_action
     OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
     OR NEW.sla_due_at IS DISTINCT FROM OLD.sla_due_at
     OR NEW.exception_reason IS DISTINCT FROM OLD.exception_reason
     OR NEW.origin_source IS DISTINCT FROM OLD.origin_source
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.product_model IS DISTINCT FROM OLD.product_model
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'lead_assignments é imutável: campo protegido';
  END IF;
  IF OLD.next_assignment_id IS NOT NULL AND NEW.next_assignment_id IS DISTINCT FROM OLD.next_assignment_id THEN
    RAISE EXCEPTION 'lead_assignments é imutável: next_assignment_id já definido';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_assignments_guard_update BEFORE UPDATE ON public.lead_assignments FOR EACH ROW EXECUTE FUNCTION public.lead_assignments_guard();
CREATE TRIGGER lead_assignments_guard_delete BEFORE DELETE ON public.lead_assignments FOR EACH ROW EXECUTE FUNCTION public.lead_assignments_guard();

-- Leitura por organização, como as demais tabelas. Escrita só por service_role (as funções SECURITY DEFINER).
-- O isolamento por vendedor, nesta fase, é da aplicação (fase 2 da spec trata RLS por vendedor).
ALTER TABLE public.sales_reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_distribution_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_distribution_shadow_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_distribution_shadow_log_select ON public.lead_distribution_shadow_log FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY sales_reps_select ON public.sales_reps FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY lead_distribution_state_select ON public.lead_distribution_state FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY lead_assignments_select ON public.lead_assignments FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));

-- KPIs de tempo. handoff_at é herdado em toda redistribuição: o tempo handoff → primeira resposta cobre a cadeia inteira.
CREATE VIEW public.lead_response_metrics WITH (security_invoker = true) AS
SELECT a.id AS assignment_id, a.organization_id, a.chain_id, a.rep_id, a.reason, a.status, a.sla_breached,
       a.handoff_at, a.assigned_at, a.accepted_at, a.first_human_message_at,
       EXTRACT(EPOCH FROM (a.first_human_message_at - a.handoff_at))::integer AS handoff_to_first_human_seconds,
       EXTRACT(EPOCH FROM (a.first_human_message_at - a.assigned_at))::integer AS assigned_to_first_human_seconds,
       EXTRACT(EPOCH FROM (a.accepted_at - a.assigned_at))::integer AS assigned_to_accepted_seconds
FROM public.lead_assignments a
WHERE a.rep_id IS NOT NULL AND a.reason <> 'bulk_reassignment';
