import { z } from "zod";
import { ALLOWED_DOCUMENT_TYPES, MAX_DOCUMENT_SIZE_BYTES } from "../constants";

export const uploadDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  agent_id: z.string().uuid(),
});

export const validateDocumentFile = z.object({
  file_name: z.string().min(1),
  file_size_bytes: z.number().int().positive().max(MAX_DOCUMENT_SIZE_BYTES),
  file_type: z.enum(ALLOWED_DOCUMENT_TYPES),
});

export const createFaqSchema = z.object({
  agent_id: z.string().uuid(),
  question: z.string().min(1).max(1000),
  answer: z.string().min(1).max(5000),
});

export const updateFaqSchema = z.object({
  question: z.string().min(1).max(1000).optional(),
  answer: z.string().min(1).max(5000).optional(),
  is_active: z.boolean().optional(),
});
