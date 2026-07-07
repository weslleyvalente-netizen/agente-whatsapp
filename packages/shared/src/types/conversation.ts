export type ConversationStatus = "open" | "waiting" | "resolved" | "closed";

export interface Conversation {
  id: string;
  organization_id: string;
  agent_id: string;
  evolution_instance_id: string;
  contact_id: string;
  status: ConversationStatus;
  is_human_takeover: boolean;
  human_takeover_at: string | null;
  assigned_to: string | null;
  tags: string[];
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationNote {
  id: string;
  conversation_id: string;
  organization_id: string;
  user_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationMetrics {
  id: string;
  conversation_id: string;
  organization_id: string;
  first_response_time_ms: number | null;
  resolution_time_ms: number | null;
  message_count: number;
  human_messages_count: number;
  satisfaction_rating: number | null;
  created_at: string;
}
