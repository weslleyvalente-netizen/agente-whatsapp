-- Public bucket for images the agent sends on WhatsApp (knowledge.imagens).
-- Public because Evolution API downloads the media from its URL. Writes go
-- only through the API with the service role, so no insert/update policy is
-- granted to authenticated/anon users.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agent-media', 'agent-media', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
