import { getAdminClient, getOrganizationById, listSalesReps } from "@aula-agente/database";
import { isLeadVisible, isManager, resolveLeadVisibility } from "./lead-visibility.js";

/** Para rotas de detalhe: false quando o lead pertence a outro vendedor. Gestores e flag desligada não consultam nada. */
export async function canViewLead(
  db: ReturnType<typeof getAdminClient>, organizationId: string, role: string, userId: string, ownerUserId: string | null | undefined
): Promise<boolean> {
  if (isManager(role) || !ownerUserId || ownerUserId === userId) return true;
  const org = await getOrganizationById(db, organizationId);
  const viewer = resolveLeadVisibility({ role, userId, leadDistributionEnabled: org.settings.lead_distribution_enabled === true });
  if (viewer.mode === "all") return true;
  const reps = await listSalesReps(db, organizationId);
  return isLeadVisible(viewer, ownerUserId, new Set(reps.map(r => r.user_id)));
}
