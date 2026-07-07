import { z } from "zod";

export const upsertContactSchema = z.object({
  phone: z.string().min(10).max(20),
  name: z.string().max(200).nullable().default(null),
  photo_url: z.string().url().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});
