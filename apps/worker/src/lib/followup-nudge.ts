import type { Message } from "@aula-agente/shared";

export function buildFollowupNudgeInstruction(stage: 1 | 2, hoursSilent: number): string {
  const hours = Math.round(hoursSilent);
  const hourWord = hours === 1 ? "1 hora" : `${hours} horas`;

  if (stage === 1) {
    return (
      `O cliente não respondeu à sua última mensagem há mais de ${hourWord}. ` +
      `Se ainda fizer sentido dentro do contexto da conversa, escreva uma mensagem ` +
      `curta e natural pra retomar o contato — sem soar repetitivo ou robótico. ` +
      `Se não fizer sentido insistir agora, responda só com uma string vazia, sem nenhum texto.`
    );
  }

  return (
    `Essa é a sua última tentativa automática de reengajar esse cliente — ele não ` +
    `respondeu nem à sua mensagem anterior, e já se passaram mais de ${hourWord} no ` +
    `total sem resposta. Se ainda fizer sentido, escreva uma mensagem breve e natural ` +
    `tentando retomar o contato pela última vez. Se não fizer sentido insistir, ` +
    `responda só com uma string vazia, sem nenhum texto.`
  );
}

// Message-shaped so it can be passed straight into runAgent's `currentMessage`
// (see packages/agent-runtime's buildFinalTurnMessage) without persisting a
// row — id/created_at are placeholders, never written to the database.
export function buildFollowupNudgeMessage(params: {
  conversationId: string;
  organizationId: string;
  stage: 1 | 2;
  hoursSilent: number;
}): Message {
  return {
    id: "",
    conversation_id: params.conversationId,
    organization_id: params.organizationId,
    evolution_message_id: null,
    role: "system",
    content: buildFollowupNudgeInstruction(params.stage, params.hoursSilent),
    media_url: null,
    media_type: null,
    metadata: null,
    created_at: new Date().toISOString(),
  };
}
