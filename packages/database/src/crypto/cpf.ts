import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getEncryptionKey(): Buffer {
  const hex = process.env.QUALIFICATION_CPF_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("QUALIFICATION_CPF_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

function getHashPepper(): string {
  const pepper = process.env.QUALIFICATION_CPF_HASH_PEPPER;
  if (!pepper) {
    throw new Error("QUALIFICATION_CPF_HASH_PEPPER must be set");
  }
  return pepper;
}

// Stored as "iv:authTag:ciphertext", each hex-encoded — self-contained, no
// separate columns needed for the IV/auth tag.
export function encryptCpf(plainCpf: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainCpf, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptCpf(stored: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

// HMAC with a pepper distinct from the encryption key, so leaking one
// secret alone doesn't compromise the other. Used to detect a CPF change
// (hash comparison) without ever decrypting.
export function hashCpf(plainCpf: string): string {
  return createHmac("sha256", getHashPepper()).update(plainCpf).digest("hex");
}
