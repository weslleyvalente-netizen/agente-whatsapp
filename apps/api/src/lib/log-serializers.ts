// Log de requisição sem segredos na URL: o webhook da UAZAPI leva o WEBHOOK_SECRET em ?apikey= (a UAZAPI não manda cabeçalho
// próprio), e o serializador padrão do Fastify grava a URL inteira.
import type { FastifyRequest } from "fastify";

const SECRET_PARAMS = /([?&](?:apikey|key|token)=)[^&#]*/gi;

export function redactUrlSecrets(url: string): string {
  return url.replace(SECRET_PARAMS, "$1[redacted]");
}

export function requestLogSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrlSecrets(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
