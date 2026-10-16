-- Bucket PRIVADO para os áudios recebidos de clientes (player nas conversas).
-- Diferente do bucket "agent-media" (público), áudio de cliente nunca pode ter
-- link aberto: o acesso é só por link temporário (signed URL) emitido pela API
-- depois de checar a permissão do usuário. Sem policies para anon/authenticated:
-- apenas a chave de serviço (API/worker) lê e grava. Retenção de 90 dias feita
-- por rotina do worker (apaga o arquivo e zera messages.media_url).
-- "do update" garante public = false mesmo se o bucket já existir como público.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-audio', 'customer-audio', false, 52428800,
  array['audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/wav']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Índice parcial para a rotina diária de retenção (mensagens com áudio guardado, por data).
create index if not exists idx_messages_customer_audio_created_at
  on messages (created_at)
  where media_url like 'storage:customer-audio/%';
