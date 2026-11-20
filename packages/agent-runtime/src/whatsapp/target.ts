// Qual provedor atende uma instância (pelo nome, que é o que os pontos de envio/mídia conhecem).
// Sem UAZAPI configurada no ambiente, é sempre a Evolution e o banco nem é consultado (comportamento de antes).
import { getAdminClient, getInstanceByInstanceName } from "@aula-agente/database";
import { decryptInstanceToken } from "./instance-token.js";

export type WhatsAppTarget = { provider: "evolution"; instanceName: string } | { provider: "uazapi"; instanceName: string; token: string };

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; row: InstanceRow | null }>();

type InstanceRow = { instance_name: string; provider?: string | null; provider_token_encrypted?: string | null };

export function targetFromInstance(row: InstanceRow): WhatsAppTarget {
  if (row.provider !== "uazapi") return { provider: "evolution", instanceName: row.instance_name };
  if (!row.provider_token_encrypted) throw new Error("instância em UAZAPI sem token: conecte a UAZAPI antes de virar");
  return { provider: "uazapi", instanceName: row.instance_name, token: decryptInstanceToken(row.provider_token_encrypted) };
}

export async function resolveWhatsAppTarget(instanceName: string): Promise<WhatsAppTarget> {
  if (!process.env.UAZAPI_BASE_URL) return { provider: "evolution", instanceName };
  const hit = cache.get(instanceName);
  let row: InstanceRow | null;
  if (hit && Date.now() - hit.at < TTL_MS) row = hit.row;
  else {
    row = await getInstanceByInstanceName(getAdminClient(), instanceName);
    cache.set(instanceName, { at: Date.now(), row });
  }
  return row ? targetFromInstance(row) : { provider: "evolution", instanceName };
}

export function resetWhatsAppTargetCache(): void {
  cache.clear();
}
