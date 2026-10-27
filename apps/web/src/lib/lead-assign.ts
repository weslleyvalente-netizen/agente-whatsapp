/** A troca de responsável pelo dropdown da conversa passa pelo fluxo de reatribuição (histórico, prazo e aviso ao vendedor)
 *  quando o rodízio está ligado, quem troca é gestor e o destino é um vendedor cadastrado. Nos demais casos, só altera a conversa. */
export function shouldUseManualAssign(opts: { distributionOn: boolean; role: string | null; targetRepId: string | null }): boolean {
  return opts.distributionOn && (opts.role === "owner" || opts.role === "admin") && opts.targetRepId !== null;
}

/** O fluxo de reatribuição do rodízio só existe para quem já tem uma atribuição (encaminhamento). Para lead novo, cliente antigo da carteira
 *  ou conversa sem encaminhamento, o banco responde "Conversa sem atribuição…": aí a troca deve ser feita direto na conversa. */
export function isNoAssignmentError(message: string | null | undefined): boolean {
  // Casa só o começo ("sem atribui"): em produção a mensagem do banco está com os acentos corrompidos (atribui√ß√£o) por codificação antiga.
  return /sem atribui/i.test(message ?? "");
}
