import type { Message, NormalizedWixLead } from "@aula-agente/shared";

export function buildWixLeadTriggerInstruction(lead: NormalizedWixLead): string {
  const lines = [
    `Novo lead do formulário do site (Form_01). Ele ainda não te mandou nenhuma mensagem — você está iniciando o contato.`,
    `Nome: ${lead.name}`,
  ];
  if (lead.interest) lines.push(`Interesse: ${lead.interest}`);
  if (lead.budget) lines.push(`Orçamento informado: ${lead.budget}`);
  if (lead.priorExperience) lines.push(`Já fez consórcio antes: ${lead.priorExperience}`);
  if (lead.email) lines.push(`E-mail: ${lead.email}`);
  lines.push(
    `Apresente-se e conecte a abertura com o que ele já disse no formulário — nunca pergunte de novo algo que já está listado acima.`
  );
  return lines.join("\n");
}

// Message-shaped so it can be passed straight into runAgent's `currentMessage`
// (same technique as apps/worker/src/lib/followup-nudge.ts) without
// persisting a row — id/created_at are placeholders, never written to the
// database.
export function buildWixLeadTriggerMessage(params: {
  conversationId: string;
  organizationId: string;
  lead: NormalizedWixLead;
}): Message {
  return {
    id: "",
    conversation_id: params.conversationId,
    organization_id: params.organizationId,
    evolution_message_id: null,
    role: "system",
    content: buildWixLeadTriggerInstruction(params.lead),
    media_url: null,
    media_type: null,
    metadata: null,
    created_at: new Date().toISOString(),
  };
}
