import { z } from "zod";

// Body shape for the Wix "Send HTTP request" automation action on
// Form_01 (site lead form) — configured manually in the Wix dashboard to
// map each form question to these keys. See
// specs/2026-09-11-wix-lead-webhook-design.md.
//
// interest/budget/priorExperience come from Wix "choice" fields (dropdown
// options), which Wix serializes as an array even when a single option is
// selected — not a plain string. email/interest/budget/priorExperience are
// also sent as explicit `null` (not omitted) when the customer left them
// blank, so every optional field must be `.nullable()` too.
const choiceField = z.union([z.string(), z.array(z.string())]).nullable().optional();

export const wixLeadWebhookSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().nullable().optional(),
  interest: choiceField,
  budget: choiceField,
  priorExperience: choiceField,
});

export type WixLeadWebhookPayload = z.infer<typeof wixLeadWebhookSchema>;

export interface NormalizedWixLead {
  name: string;
  phone: string;
  email?: string;
  interest?: string;
  budget?: string;
  priorExperience?: string;
}

function flattenChoiceField(value: string | string[] | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const joined = value.filter(Boolean).join(", ");
    return joined || undefined;
  }
  return value;
}

// Collapses the raw webhook payload (nullable strings, array-or-string
// choice fields) into plain strings the rest of the app can reason about.
export function normalizeWixLead(lead: WixLeadWebhookPayload): NormalizedWixLead {
  return {
    name: lead.name,
    phone: lead.phone,
    email: lead.email ?? undefined,
    interest: flattenChoiceField(lead.interest),
    budget: flattenChoiceField(lead.budget),
    priorExperience: flattenChoiceField(lead.priorExperience),
  };
}
