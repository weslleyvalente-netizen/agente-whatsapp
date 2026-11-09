-- Conversas estilo WhatsApp (Etapa 1): foto de perfil dos contatos e mídia do chat.
-- Este arquivo é colado pelo dono no SQL Editor do Supabase. É idempotente: pode rodar mais de uma vez.
--
-- 1) wa_contacts ganha o caminho da foto de perfil e a data da última verificação.
-- 2) Dois buckets PRIVADOS (mesmo padrão de 20261016120000_customer_audio_bucket.sql):
--    - profile-pictures: fotos de perfil (até 2 MB; jpeg/png/webp).
--    - chat-media: imagens, vídeos e documentos do chat (até 25 MB; sem restrição de tipo —
--      o servidor força download para documentos).
--    Sem policies para anon/authenticated: só a chave de serviço (API/worker) lê e grava;
--    o acesso do usuário é por link temporário (signed URL) emitido pela API após checar permissão.
--    "do update" garante public = false mesmo se o bucket já existir como público.
-- 3) Índice parcial para a rotina de retenção da mídia do chat.

alter table wa_contacts
  add column if not exists profile_picture_path text,
  add column if not exists profile_picture_checked_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-pictures', 'profile-pictures', false, 2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 26214400, null)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create index if not exists idx_messages_chat_media_created_at
  on messages (created_at)
  where media_url like 'storage:chat-media/%';
