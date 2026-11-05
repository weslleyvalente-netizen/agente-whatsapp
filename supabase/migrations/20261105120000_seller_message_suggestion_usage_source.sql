-- Additive: permite registrar o custo de "Sugerir mensagem" no card; linhas existentes não mudam.
ALTER TABLE ai_usage_events
  DROP CONSTRAINT ai_usage_events_source_check,
  ADD CONSTRAINT ai_usage_events_source_check CHECK (source IN ('playground', 'trainer', 'image_description', 'import_suggestion', 'task_followup_suggestion', 'seller_message_suggestion'));
