import { z } from "zod";

export const organizationSettingsSchema = z.object({
  max_documents: z.number().int().positive().default(100),
  max_agents: z.number().int().positive().default(5),
  max_instances: z.number().int().positive().default(3),
});

export const createOrganizationSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  plan: z.enum(["free", "pro", "enterprise"]).default("free"),
  settings: organizationSettingsSchema.optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "agent"]),
});
