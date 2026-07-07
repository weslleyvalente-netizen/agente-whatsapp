import { getAdminClient } from "@aula-agente/database";

export function getSupabase() {
  return getAdminClient();
}
