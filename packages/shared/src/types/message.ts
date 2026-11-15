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
  // Entrega/leitura de mensagens enviadas (✓✓). Ausente em mensagens antigas.
  delivered_at?: string | null;
  read_at?: string | null;
  created_at: string;
}

export interface MessageMetadata {
  source?: "task_followup" | "automatic_followup" | "seller_audio" | "seller_attachment";
  // Estado da mídia (imagem/vídeo/documento) guardada no Storage.
  media?: { status: "stored" | "too_large" | "failed"; file_name?: string; mime_type?: string; size_bytes?: number };
  // O envio falhou de forma definitiva (ISO): a mensagem nunca chegou ao WhatsApp. Vale para qualquer mensagem nossa.
  send_failed_at?: string;
  // Motivo resumido do envio que falhou (status HTTP e mensagem da Evolution, sem chaves nem telefones).
  send_error?: string;
  // A mesma mensagem marcada como falha foi depois aceita pela Evolution (reenvio): a marca de falha sai e este rastro fica (ISO).
  send_recovered_at?: string;
  // Reenvio explícito: id da mensagem que falhou e que esta mensagem substitui (evidência de recuperação).
  resend_of?: string;
  task_id?: string;
  audio_transcribed_at?: string;
  low_intent_followup?: { anchor: string; stage: 1 | 2 | 3; confirmed_at?: string };
  scheduled_ad_closure?: { batch_id:string; attempted_at?:string; cancelled_at?:string; confirmed_at?:string };
  // Varredura de cliente sem resposta: o webhook encaminhou à IA / o pipeline da IA terminou de tratar (ISO).
  ai_routed_at?: string;
  ai_processed_at?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cache_status?: "hit" | "write" | "none";
  latency_ms?: number;
  tool_calls?: string[];
  duration_seconds?: number;
}
