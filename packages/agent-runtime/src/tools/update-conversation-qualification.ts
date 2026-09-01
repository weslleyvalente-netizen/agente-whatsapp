import { tool, type Tool } from "ai";
import { z } from "zod";
import { getAdminClient, upsertConversationQualification } from "@aula-agente/database";

interface UpdateQualificationToolContext {
  contactId: string;
  conversationId: string;
  organizationId: string;
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

        await upsertConversationQualification(db, {
          organizationId: context.organizationId,
          conversationId: context.conversationId,
          contactId: context.contactId,
          changedByType: "ai",
          changedById: null,
          fields: commercialFields,
          identity: cpf ? { cpf, birth_date, has_driver_license, driver_license_category } : undefined,
        });

        return "Dados de qualificação atualizados.";
      } catch (err) {
        console.error("updateConversationQualification tool failed:", err);
        return "Não foi possível atualizar os dados de qualificação agora.";
      }
    },
  });
}
