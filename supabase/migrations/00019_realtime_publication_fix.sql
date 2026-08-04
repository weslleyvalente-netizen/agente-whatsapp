-- `conversations` and `messages` were never added to the supabase_realtime
-- publication, despite the Inbox dashboard subscribing to both via
-- postgres_changes since they were built. Every "new message"/"status
-- changed" realtime update silently never fired — the UI only ever
-- reflected new activity after a manual page reload. Found live in
-- production (2026-08-04) while investigating a user report that
-- conversations weren't updating without a refresh.
--
-- IF NOT EXISTS-safe: repeatable if this migration is re-applied to a
-- project where these were already added manually (as they were here,
-- ahead of this migration being written).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;
END $$;
