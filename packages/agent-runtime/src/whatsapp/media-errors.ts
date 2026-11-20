// Mídia maior que o limite configurado. Nome histórico (vinha da Evolution); vale para os dois provedores.
export class EvolutionMediaTooLargeError extends Error {
  constructor(public readonly contentLength: number) {
    super(`Evolution media too large (content-length ${contentLength})`);
    this.name = "EvolutionMediaTooLargeError";
  }
}
