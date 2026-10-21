/** A troca de responsável pelo dropdown da conversa passa pelo fluxo de reatribuição (histórico, prazo e aviso ao vendedor)
 *  quando o rodízio está ligado, quem troca é gestor e o destino é um vendedor cadastrado. Nos demais casos, só altera a conversa. */
export function shouldUseManualAssign(opts: { distributionOn: boolean; role: string | null; targetRepId: string | null }): boolean {
  return opts.distributionOn && (opts.role === "owner" || opts.role === "admin") && opts.targetRepId !== null;
}
