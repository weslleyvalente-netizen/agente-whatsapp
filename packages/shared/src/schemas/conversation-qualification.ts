import { z } from "zod";

export const updateConversationQualificationSchema = z.object({
  attendance_type: z.enum(["financing", "consortium", "cash", "workshop"]).nullable().optional(),
  product_interest: z.string().max(500).nullable().optional(),
  product_model: z.string().max(500).nullable().optional(),
  usage_purpose: z.string().max(500).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  urgency: z.enum(["immediate", "this_week", "flexible"]).nullable().optional(),
  sale_amount: z.number().nullable().optional(),
  credit_amount: z.number().nullable().optional(),
  down_payment_amount: z.number().nullable().optional(),
  bid_amount: z.number().nullable().optional(),
  target_installment_amount: z.number().nullable().optional(),
  term_months: z.number().int().nullable().optional(),
  summary: z.string().max(5000).nullable().optional(),
  next_action: z.string().max(2000).nullable().optional(),
  commercial_notes: z.string().max(5000).nullable().optional(),
  cpf: z.string().regex(/^\d{11}$/, "CPF deve ter 11 dígitos numéricos").nullable().optional(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  has_driver_license: z.boolean().nullable().optional(),
  driver_license_category: z.string().max(10).nullable().optional(),
});
