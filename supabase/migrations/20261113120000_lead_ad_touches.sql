-- Origem estruturada por anúncio ("toques"): uma linha por anúncio pelo qual o contato chegou ou voltou.
-- O selo de origem do card continua vindo de wa_contacts.metadata.lead_origin (primeira origem, correção manual): nada disso muda.
-- Só estados e identificadores do anúncio (externalAdReply); nunca conteúdo de conversa. A campanha NÃO vem do WhatsApp:
-- campaign_id/campaign_name ficam nulos até serem preenchidos por cruzamento (ad_id) com os dados de mídia paga.
-- Sem efeito enquanto a API não gravar toques; nada é preenchido retroativamente. Idempotente.

CREATE TABLE IF NOT EXISTS public.lead_ad_touches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  -- Mensagem do WhatsApp que trouxe o contexto: evita toque duplicado em reenvio/recuperação de mensagens.
  evolution_message_id text,
  touched_at timestamptz NOT NULL,
  platform text NOT NULL CHECK (platform IN ('instagram', 'facebook', 'meta')),
  source_type text,
  ad_id text,
  ad_title text,
  ad_body text,
  ad_url text,
  ctwa_clid text,
  campaign_id text,
  campaign_name text,
  -- Identifica "o mesmo anúncio": id do anúncio, senão link sem parâmetros, senão título e texto normalizados.
  touch_key text NOT NULL,
  -- Nomes (sem valores) dos campos que o WhatsApp enviou preenchidos: valida o que ele realmente fornece.
  available_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_ad_touches_message_uniq
  ON public.lead_ad_touches (organization_id, evolution_message_id) WHERE evolution_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_ad_touches_contact_time
  ON public.lead_ad_touches (organization_id, contact_id, touched_at DESC);
-- Cruzamento com a mídia paga (id do anúncio) e relatórios por anúncio.
CREATE INDEX IF NOT EXISTS lead_ad_touches_ad
  ON public.lead_ad_touches (organization_id, ad_id, touched_at DESC) WHERE ad_id IS NOT NULL;

-- Só a service role (API) acessa: RLS ligada e nenhuma policy.
ALTER TABLE public.lead_ad_touches ENABLE ROW LEVEL SECURITY;

-- Toque que originou cada oportunidade, só com evidência (mesma regra de attributeTouch, packages/shared/src/lead-ad-touch.ts;
-- os dois são validados contra os mesmos cenários em supabase/tests/ad-attribution-scenarios.json):
-- 1) toque ligado a uma conversa VINCULADA à oportunidade (lead_assignments.conversation_id, a mesma relação que a API usa) e até a
--    criação dela, sem limite de idade: basis 'conversation' (comprovada);
-- 2) senão, o mais recente dentro de 14 dias antes da criação: basis 'estimated' (estimada, NÃO comprovada);
-- 3) senão nada: touch_id nulo e basis 'indeterminate'. Tolerância de 1 min de relógio.
-- O histórico completo fica em lead_ad_touches.
CREATE OR REPLACE VIEW public.opportunity_ad_origins WITH (security_invoker = true) AS
SELECT o.id AS opportunity_id, o.organization_id, o.contact_id,
       t.id AS touch_id, COALESCE(t.basis, 'indeterminate') AS basis,
       t.touched_at, t.platform, t.source_type, t.ad_id, t.ad_title, t.ad_body, t.ad_url, t.campaign_id, t.campaign_name
FROM public.opportunities o
LEFT JOIN LATERAL (
  SELECT x.*, CASE WHEN x.linked THEN 'conversation' ELSE 'estimated' END AS basis
  FROM (
    SELECT t.*, (t.conversation_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM public.lead_assignments la
             WHERE la.organization_id = o.organization_id AND la.opportunity_id = o.id AND la.conversation_id = t.conversation_id
           )) AS linked
    FROM public.lead_ad_touches t
    WHERE t.organization_id = o.organization_id AND t.contact_id = o.contact_id
      AND t.touched_at <= o.created_at + interval '1 minute'
  ) x
  WHERE x.linked OR x.touched_at >= o.created_at - interval '14 days'
  ORDER BY x.linked DESC, x.touched_at DESC
  LIMIT 1
) t ON true;
