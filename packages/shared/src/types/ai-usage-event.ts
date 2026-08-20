// LLM calls that don't produce a row in `messages` — Playground and Trainer
// turns, per-image description calls, and config-import suggestions — but
// still cost real money on the same Anthropic API key.
export type AiUsageSource = "playground" | "trainer" | "image_description" | "import_suggestion";

export interface AiUsageEvent {
  id: string;
  organization_id: string;
  agent_id: string;
  source: AiUsageSource;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  created_at: string;
}
