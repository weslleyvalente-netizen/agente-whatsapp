import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeDocument, KnowledgeFaq } from "@aula-agente/shared";

export async function getDocumentsByAgent(client: SupabaseClient, agentId: string) {
  const { data, error } = await client
    .from("knowledge_documents")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as KnowledgeDocument[];
}

export async function getDocumentById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("knowledge_documents")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as KnowledgeDocument;
}

export async function createDocument(
  client: SupabaseClient,
  doc: Omit<KnowledgeDocument, "id" | "created_at" | "updated_at" | "chunk_count" | "error_message">
) {
  const { data, error } = await client
    .from("knowledge_documents")
    .insert({ ...doc, chunk_count: 0 })
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeDocument;
}

export async function updateDocument(
  client: SupabaseClient,
  id: string,
  updates: Partial<KnowledgeDocument>
) {
  const { data, error } = await client
    .from("knowledge_documents")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeDocument;
}

export async function deleteDocument(client: SupabaseClient, id: string) {
  await client.from("knowledge_chunks").delete().eq("document_id", id);
  const { error } = await client.from("knowledge_documents").delete().eq("id", id);
  if (error) throw error;
}

export async function insertChunks(
  client: SupabaseClient,
  chunks: Array<{
    document_id: string;
    organization_id: string;
    content: string;
    metadata: Record<string, unknown>;
    embedding: number[];
    chunk_index: number;
  }>
) {
  const { error } = await client.from("knowledge_chunks").insert(chunks);
  if (error) throw error;
}

export async function searchKnowledgeChunks(
  client: SupabaseClient,
  organizationId: string,
  agentId: string,
  embedding: number[],
  limit = 5
) {
  const { data, error } = await client.rpc("search_knowledge_chunks", {
    query_embedding: embedding,
    match_count: limit,
    filter_organization_id: organizationId,
    filter_agent_id: agentId,
  });
  if (error) throw error;
  return data as Array<{ id: string; content: string; similarity: number }>;
}

export async function getFaqsByAgent(client: SupabaseClient, agentId: string) {
  const { data, error } = await client
    .from("knowledge_faqs")
    .select("*")
    .eq("agent_id", agentId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as KnowledgeFaq[];
}

export async function createFaq(
  client: SupabaseClient,
  faq: Omit<KnowledgeFaq, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client
    .from("knowledge_faqs")
    .insert(faq)
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeFaq;
}

export async function updateFaq(
  client: SupabaseClient,
  id: string,
  updates: Partial<KnowledgeFaq>
) {
  const { data, error } = await client
    .from("knowledge_faqs")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeFaq;
}

export async function deleteFaq(client: SupabaseClient, id: string) {
  const { error } = await client.from("knowledge_faqs").delete().eq("id", id);
  if (error) throw error;
}
