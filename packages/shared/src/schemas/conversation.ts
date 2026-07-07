import { z } from "zod";

export const updateConversationSchema = z.object({
  status: z.enum(["open", "waiting", "resolved", "closed"]).optional(),
  is_human_takeover: z.boolean().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const createConversationNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});
