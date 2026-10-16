-- Bucket PRIVADO para os áudios recebidos de clientes (player nas conversas).
-- Diferente do bucket "agent-media" (público), áudio de cliente nunca pode ter
-- link aberto: o acesso é só por link temporário (signed URL) emitido pela API
-- depois de checar a permissão do usuário. Sem policies para anon/authenticated:
-- apenas a chave de serviço (API/worker) lê e grava. Retenção de 90 dias feita
-- por rotina do worker (apaga o arquivo e zera messages.media_url).
insert into storage.buckets (id, name, public)
values ('customer-audio', 'customer-audio', false)
on conflict (id) do nothing;
