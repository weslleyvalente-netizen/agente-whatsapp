// Token da instância na UAZAPI, guardado cifrado em evolution_instances.provider_token_encrypted.
// AES-256-GCM no formato "iv:tag:cifra" (hex), como packages/database/src/crypto/cpf.ts. A chave sai do UAZAPI_ADMIN_TOKEN, que já
// é o segredo mais forte da integração (com ele se lê qualquer instância): não há segredo novo para configurar. Se o token de
// administrador for trocado, os tokens guardados ficam ilegíveis e basta "Conectar UAZAPI" de novo.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function key(): Buffer {
  const admin = process.env.UAZAPI_ADMIN_TOKEN;
  if (!admin) throw new Error("UAZAPI_ADMIN_TOKEN não configurado");
  return createHash("sha256").update("aula-agente/uazapi-instance-token/v1\0" + admin).digest();
}

export function encryptInstanceToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

export function decryptInstanceToken(stored: string): string {
  const k = key();
  try {
    const [iv, tag, data] = stored.split(":");
    const decipher = createDecipheriv(ALGORITHM, k, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(data, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("token da instância UAZAPI ilegível (token de administrador trocado?)");
  }
}
