-- Sustenta as consultas do alerta de silêncio (última mensagem de cliente e contagem por faixa de horário) por organização.
create index if not exists idx_messages_org_role_created_at
  on messages (organization_id, role, created_at desc);
