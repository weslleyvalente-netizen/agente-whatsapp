import { z } from "zod";
import { SECTION_ORDER } from "../agent-config-sections.js";

export const sectionKeySchema = z.enum([...SECTION_ORDER]);

export const trainerConflictGenSchema = z.object({
  description: z.string(),
  resolution_options: z.array(z.string()),
});

export const trainerCandidateGenSchema = z.object({
  section: sectionKeySchema,
  item: z.string().nullable(),
  summary: z.string(),
  rationale: z.string(),
  conflicts: z.array(trainerConflictGenSchema),
});

export const trainerReplyGenSchema = z.object({
  content: z.string(),
  candidates: z.array(trainerCandidateGenSchema),
});

export const sendTrainerMessageSchema = z.object({
  content: z.string().min(1).max(4000),
  // Explicit opt-in to reading real customer conversations as context for
  // this message (the "Analisar conversas reais" quick action). It is a
  // structural signal from the client, never inferred from the wording of
  // `content` — scanning real message content has a cost and a privacy
  // surface the user has to choose on purpose. Omitted means false.
  analyzeConversations: z.boolean().optional(),
});
