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
});
