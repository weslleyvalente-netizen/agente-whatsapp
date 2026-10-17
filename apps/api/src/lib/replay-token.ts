import { randomBytes } from "node:crypto";

// Token aleatório por processo, conhecido só pela rota de recuperação de mensagens.
// O webhook só respeita o cabeçalho de replay quando ele carrega este token (e há WEBHOOK_SECRET válido),
// então um cliente externo, mesmo com o segredo do webhook, não consegue forjar created_at.
export const REPLAY_TOKEN = randomBytes(24).toString("hex");
