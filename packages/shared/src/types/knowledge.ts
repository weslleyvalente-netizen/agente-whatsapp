export type DocumentStatus = "processing" | "ready" | "error";

export type DocumentFileType = "pdf" | "txt" | "md" | "docx" | "csv";

export interface KnowledgeDocument {
  id: string;
  agent_id: string;
  organization_id: string;
  title: string;
  file_name: string;
  file_url: string;
  file_type: DocumentFileType;
  file_size_bytes: number;
  status: DocumentStatus;
  error_message: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  document_id: string;
  organization_id: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
  chunk_index: number;
  created_at: string;
}

export interface KnowledgeFaq {
  id: string;
  agent_id: string;
  organization_id: string;
  question: string;
  answer: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
