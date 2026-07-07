import { getAdminClient } from "@aula-agente/database";
import { createDocument } from "@aula-agente/database";
import { getProcessDocumentQueue } from "@aula-agente/queue";
import { MAX_DOCUMENT_SIZE_BYTES, ALLOWED_DOCUMENT_TYPES } from "@aula-agente/shared";
import type { DocumentFileType } from "@aula-agente/shared";

interface UploadDocumentParams {
  organizationId: string;
  agentId: string;
  title: string;
  fileName: string;
  fileBuffer: Buffer;
  fileType: DocumentFileType;
}

export async function uploadDocument(params: UploadDocumentParams) {
  const { organizationId, agentId, title, fileName, fileBuffer, fileType } = params;

  // Validate file type
  if (!ALLOWED_DOCUMENT_TYPES.includes(fileType as any)) {
    throw new Error(`Invalid file type: ${fileType}. Allowed: ${ALLOWED_DOCUMENT_TYPES.join(", ")}`);
  }

  // Validate file size
  if (fileBuffer.length > MAX_DOCUMENT_SIZE_BYTES) {
    throw new Error(`File too large. Max size: ${MAX_DOCUMENT_SIZE_BYTES / 1024 / 1024}MB`);
  }

  const db = getAdminClient();

  // Upload to Supabase Storage
  const storagePath = `${organizationId}/${agentId}/${Date.now()}-${fileName}`;
  const { error: storageError } = await db.storage
    .from("knowledge-documents")
    .upload(storagePath, fileBuffer, {
      contentType: `application/${fileType}`,
      upsert: false,
    });

  if (storageError) throw storageError;

  const { data: urlData } = db.storage
    .from("knowledge-documents")
    .getPublicUrl(storagePath);

  // Create document record
  const document = await createDocument(db, {
    organization_id: organizationId,
    agent_id: agentId,
    title,
    file_name: fileName,
    file_url: urlData.publicUrl,
    file_type: fileType,
    file_size_bytes: fileBuffer.length,
    status: "processing",
  });

  // Enqueue processing job
  const queue = getProcessDocumentQueue();
  await queue.add("process-document", {
    documentId: document.id,
    organizationId,
    agentId,
  });

  return document;
}
