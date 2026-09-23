import { z } from "zod";
import { OPERATIONS, WAITING_ON_OPTIONS, PRODUCTS, isValidStage } from "../constants.js";

const evidenceSchema = z.string().trim().min(1, "Evidência é obrigatória");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve estar no formato YYYY-MM-DD");
const datetimeSchema = z.string().datetime({ offset: true });

export const createOpportunitySchema = z
  .object({
    contact_id: z.string().uuid(),
    operation: z.enum(OPERATIONS),
    stage: z.string().min(1),
    product: z.enum(PRODUCTS).nullable().optional(),
    product_model: z.string().max(200).nullable().optional(),
    owner_id: z.string().uuid(),
    next_action: z.string().min(1, "Próxima ação é obrigatória"),
    next_action_due_date: dateSchema,
    sale_amount: z.coerce.number().nonnegative().nullable().optional(),
    credit_amount: z.coerce.number().nonnegative().nullable().optional(),
    down_payment_amount: z.coerce.number().nonnegative().nullable().optional(),
    bid_amount: z.coerce.number().nonnegative().nullable().optional(),
    target_installment_amount: z.coerce.number().nonnegative().nullable().optional(),
    term_months: z.coerce.number().int().positive().nullable().optional(),
    usage_purpose: z.string().max(500).nullable().optional(),
    urgency: z.string().max(200).nullable().optional(),
    main_objection: z.string().max(1000).nullable().optional(),
    commercial_notes: z.string().max(5000).nullable().optional(),
    // Only meaningful for backfilling historical leads: lets the creation
    // event carry the real classification rationale and lets the record's
    // timestamps reflect when the negotiation actually happened, instead of
    // the moment it was imported. Omitted on every normal UI creation.
    evidence: evidenceSchema.optional(),
    created_at: datetimeSchema.optional(),
    last_interaction_at: datetimeSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (!isValidStage(data.operation, data.stage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Estágio "${data.stage}" não existe no funil "${data.operation}"`,
        path: ["stage"],
      });
    }
  });

export const updateOpportunitySchema = z.object({
  owner_id: z.string().uuid().nullable().optional(),
  next_action: z.string().nullable().optional(),
  next_action_due_date: dateSchema.nullable().optional(),
  waiting_on: z.enum(WAITING_ON_OPTIONS).nullable().optional(),
  waiting_on_until: dateSchema.nullable().optional(),
  product: z.enum(PRODUCTS).nullable().optional(),
  product_model: z.string().max(200).nullable().optional(),
  sale_amount: z.coerce.number().nonnegative().nullable().optional(),
  credit_amount: z.coerce.number().nonnegative().nullable().optional(),
  down_payment_amount: z.coerce.number().nonnegative().nullable().optional(),
  bid_amount: z.coerce.number().nonnegative().nullable().optional(),
  target_installment_amount: z.coerce.number().nonnegative().nullable().optional(),
  term_months: z.coerce.number().int().positive().nullable().optional(),
  usage_purpose: z.string().max(500).nullable().optional(),
  urgency: z.string().max(200).nullable().optional(),
  main_objection: z.string().max(1000).nullable().optional(),
  commercial_notes: z.string().max(5000).nullable().optional(),
});

export const changeOpportunityStageSchema = z.object({
  stage: z.string().min(1),
  evidence: evidenceSchema,
});

export const changeOpportunityOperationSchema = z.object({
  operation: z.enum(OPERATIONS),
  evidence: evidenceSchema,
});

export const markOpportunityWonSchema = z.object({
  evidence: evidenceSchema,
});

export const markOpportunityLostSchema = z.object({
  evidence: evidenceSchema,
  lost_reason: z.string().min(1, "Motivo da perda é obrigatório"),
  resume_date: dateSchema.nullable().optional(),
});
