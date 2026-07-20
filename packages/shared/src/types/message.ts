export type MessageRole = "contact" | "agent" | "human_agent" | "system";

export type MediaType = "text" | "image" | "audio" | "video" | "document" | "sticker" | "location";

export interface Message {
  id: string;
  conversation_id: string;
  organization_id: string;
  evolution_message_id: string | null;
  role: MessageRole;
  content: string;
  media_url: string | null;
  media_type: MediaType | null;
  metadata: MessageMetadata | null;
  created_at: string;
}

export interface MessageMetadata {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  tool_calls?: string[];
}
