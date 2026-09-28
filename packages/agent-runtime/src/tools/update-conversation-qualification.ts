import { tool, type Tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@aula-agente/database";
import {
  getAdminClient,
  upsertConversationQualification,
  getQualificationByConversationId,
  getOrganizationById,
  getLastContactMessage,
  findOpenTaskWithPendencyType,
  resolveAwaitingCustomerPendency,
} from "@aula-agente/database";
import { isAwaitingCustomerResolved, type ConversationQualification, type Task } from "@aula-agente/shared";

interface UpdateQualificationToolContext {
  contactId: string;
  conversationId: string;
  organizationId: string;
}

// Fields whose change signals "the customer just answered" — see
// isAwaitingCustomerResolved (packages/shared) for the full mapping to
// awaiting_customer_cpf/awaiting_customer_data.
const WATCHED_FIELDS = [
  "cpf_hash",
  "birth_date",
  "has_driver_license",
  "driver_license_category",
  "product_model",
  "down_payment_amount",
  "term_months",
] as const;

// Fase 2, item 3: closes an open awaiting_customer_cpf/awaiting_customer_data
// task (or just removes that one pendency, if others remain — see
// resolveAwaitingCustomerPendency) once the customer supplies what it was
// waiting on. Both halves of D3's criterion are required: the field must
// have actually changed in THIS call (before/after differ) AND the customer
// must have sent a message after the task was created — a value the AI (or
// a human) enters without the customer having said anything new doesn't
// count. Entirely best-effort: the caller wraps this so a failure here
// never turns a successful qualification write into a reported failure.
async function autoCloseAwaitingCustomerTasks(
  db: SupabaseClient,
  context: UpdateQualificationToolContext,
  before: ConversationQualification | null,
  after: ConversationQualification | null
): Promise<void> {
  const org = await getOrganizationById(db, context.organizationId);
  if (!org.settings?.task_auto_close_awaiting_customer_enabled) return;
  if (!after) return;

  const changedFields = WATCHED_FIELDS.filter((field) => (before?.[field] ?? null) !== (after[field] ?? null));
  if (changedFields.length === 0) return;

  const lastContactMessage = await getLastContactMessage(db, context.conversationId);

  for (const type of ["awaiting_customer_cpf", "awaiting_customer_data"] as const) {
    if (!isAwaitingCustomerResolved(type, changedFields)) continue;

    const task: Task | null = await findOpenTaskWithPendencyType(db, context.organizationId, context.contactId, type);
    if (!task) continue;

    if (!lastContactMessage || lastContactMessage.created_at <= task.created_at) continue;

    await resolveAwaitingCustomerPendency(
      db,
      context.organizationId,
      task.id,
      type,
      "Cliente respondeu e o dado foi preenchido — pendência resolvida automaticamente."
    );
  }
}

export function createUpdateConversationQualificationTool(context: UpdateQualificationToolContext): Tool {
  return tool({
    description:
      "Registra ou atualiza os dados comerciais estruturados desta conversa (produto de interesse, valores, prazo, CPF, dados de financiamento, resumo do atendimento, próxima ação). Use sempre que o cliente informar algo relevante: o que ele quer, quanto pode dar de entrada, valor de parcela desejado, CPF, data de nascimento, se tem CNH. Envie só os campos que você aprendeu agora — não precisa repetir o que já foi dito antes. Se um campo já tiver sido corrigido manualmente por um humano, esta ferramenta simplesmente ignora sua tentativa de mudá-lo, sem erro — não se preocupe com isso. Se o cliente informar um CPF diferente do que já está registrado, isso substitui o anterior automaticamente (normalmente significa que o CPF anterior já foi analisado). Não avise o cliente que você está registrando isso, é interno.",
    inputSchema: z.object({
      attendance_type: z.enum(["financing", "consortium", "cash", "workshop"]).optional(),
      product_interest: z.string().optional(),
      product_model: z.string().optional(),
      usage_purpose: z.string().optional(),
      city: z.string().optional(),
      urgency: z.enum(["immediate", "this_week", "flexible"]).optional(),
      sale_amount: z.number().optional(),
      credit_amount: z.number().optional(),
      down_payment_amount: z.number().optional(),
      bid_amount: z.number().optional(),
      target_installment_amount: z.number().optional(),
      term_months: z.number().int().optional(),
      summary: z.string().describe("Resumo comercial atualizado do atendimento, 2-4 frases").optional(),
      next_action: z.string().optional(),
      commercial_notes: z.string().optional(),
      cpf: z.string().regex(/^\d{11}$/, "11 dígitos numéricos, sem pontuação").optional(),
      birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      has_driver_license: z.boolean().optional(),
      driver_license_category: z.string().optional(),
    }),
    execute: async (input) => {
      try {
        const db = getAdminClient();
        const { cpf, birth_date, has_driver_license, driver_license_category, ...commercialFields } = input;

        const before = await getQualificationByConversationId(db, context.conversationId).catch(() => null);

        await upsertConversationQualification(db, {
          organizationId: context.organizationId,
          conversationId: context.conversationId,
          contactId: context.contactId,
          changedByType: "ai",
          changedById: null,
          fields: commercialFields,
          identity: cpf ? { cpf, birth_date, has_driver_license, driver_license_category } : undefined,
        });

        try {
          const after = await getQualificationByConversationId(db, context.conversationId);
          await autoCloseAwaitingCustomerTasks(db, context, before, after);
        } catch (err) {
          console.error("Auto-close of awaiting_customer tasks failed (non-blocking):", err);
        }

        return "Dados de qualificação atualizados.";
      } catch (err) {
        console.error("updateConversationQualification tool failed:", err);
        return "Não foi possível atualizar os dados de qualificação agora.";
      }
    },
  });
}
