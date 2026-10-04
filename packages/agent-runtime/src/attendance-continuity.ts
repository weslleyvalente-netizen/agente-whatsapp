export const ATTENDANCE_CONTEXT = `

Continuidade operacional: responda à pergunta atual e avance com os dados comerciais informados. updateQualification é registro interno, não resposta ao cliente. Não responda apenas "Fico no aguardo" a perguntas ou informações comerciais. Na falha repetida, use requestHuman se disponível, sem prometer encaminhamento antes de executar.
Financiamento convencional: não prometa "retirar na hora" antes da aprovação bancária e documentação necessária. Sobre receio de CPF, explique a finalidade da análise, ofereça humano opcional sem pressionar e não afirme resultado de score ou aprovação.
LiberaCred: garantia condicionada às regras atuais do contrato. Preserve regras e preços publicados ou retornados pelas ferramentas; não substitua preços ou invente condições.`;
const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function needsAttendanceAnswer(content: string): boolean {
  const text = normalize(content).replace(/\s+/g, " ").trim();
  if (/^(?:obrigad[oa]|valeu)(?: (?:pelo|pela|pelos|pelas) (?:catalogo|modelos|explicacao|ajuda|informacoes))?[.!]*$/.test(text)) return false;
  if (/\b(vou|irei) (enviar|mandar|passar)\b.*\b(depois|amanha|mais tarde)\b/.test(text) && !text.includes("?")) return false;
  return /\?|\b(como|qual|quais|quanto|quando|onde|por que|o que|preciso|perguntei|responde|e ai|tenho|entrada|financiar|comprar|cpf|score|documentos|catalogo|modelos?|parcelas?|precos?|me\s*explica|teria|(?:vc|voce)\s*tem|pode)\b|\br\$|\b\d+[.,]?\d*\b/.test(text);
}
export function isGenericWaiting(text: string): boolean {
  const value = normalize(text).replace(/[.!?,;:\s]+/g, " ").trim();
  return /^(?:(?:ok|certo|tudo bem|perfeito) )?(?:fico no aguardo|ficarei no aguardo|estou no aguardo|aguardo(?: seu retorno| sua resposta)?|vou aguardar)(?: entao)?$/.test(value);
}
export const RECOVERY_INSTRUCTION = `A resposta anterior não respondeu à pergunta atual. Responda agora diretamente à pergunta e aos dados comerciais do cliente usando o histórico e os resultados das ferramentas. updateQualification não substitui a resposta. Não repita apenas uma frase de espera. Não invente preços, aprovação, condições ou encaminhamento humano. Não execute ferramentas nesta continuação.`;
