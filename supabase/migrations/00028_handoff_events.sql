CREATE TABLE handoff_events (
  id                     uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id        uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  -- How this takeover (or avoided takeover) started. request_human/
  -- painel_manual/fromMe_real are real handoffs (is_human_takeover became
  -- true); fromMe_greeting_filtered is NOT a handoff -- it's logged only to
  -- measure how often a would-be takeover was avoided by the greeting filter.
  trigger_type           text NOT NULL CHECK (trigger_type IN (
                            'request_human', 'painel_manual', 'fromMe_real', 'fromMe_greeting_filtered'
                          )),

  -- Only populated for trigger_type = 'request_human'.
  motivo                 text CHECK (motivo IN (
                            'cliente_pediu', 'negociacao_valor', 'proposta_pronta',
                            'documentos', 'reclamacao', 'fora_do_escopo', 'ia_sem_resposta'
                          )),
  resumo                 text,
  urgencia               text CHECK (urgencia IN ('baixa', 'normal', 'alta')),

  criado_por             text NOT NULL CHECK (criado_por IN ('ia', 'humano', 'sistema')),
  handed_at              timestamptz NOT NULL DEFAULT now(),
  first_human_reply_at   timestamptz,

  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_handoff_events_conversation ON handoff_events(conversation_id, created_at);
CREATE INDEX idx_handoff_events_org_pending ON handoff_events(organization_id, trigger_type, first_human_reply_at)
  WHERE trigger_type = 'request_human' AND first_human_reply_at IS NULL;

ALTER TABLE handoff_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "handoff_events_select" ON handoff_events
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "handoff_events_insert" ON handoff_events
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "handoff_events_update" ON handoff_events
  FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()));
