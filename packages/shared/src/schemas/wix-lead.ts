import { z } from "zod";

// Body shape for the Wix "Send HTTP request" automation action on
// Form_01 (site lead form) — configured manually in the Wix dashboard to
// map each form question to these keys. See
// specs/2026-09-11-wix-lead-webhook-design.md.
export const wixLeadWebhookSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().optional(),
  interest: z.string().optional(),
  budget: z.string().optional(),
  priorExperience: z.string().optional(),
});

export type WixLeadWebhookPayload = z.infer<typeof wixLeadWebhookSchema>;
