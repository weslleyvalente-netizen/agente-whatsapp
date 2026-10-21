import { encryptCpf, decryptCpf, hashCpf } from '../crypto/cpf.js';
export function sealFinancingApplication(application: Record<string, unknown>, consentId: string) {
  const json = JSON.stringify(application);
  return { encrypted: encryptCpf(json), fingerprint: hashCpf(`${consentId}:${json}`) };
}
export function openFinancingApplication(encrypted: string): Record<string, unknown> {
  return JSON.parse(decryptCpf(encrypted));
}
