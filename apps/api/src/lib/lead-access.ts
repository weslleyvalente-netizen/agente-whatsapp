import { getAdminClient, getOrganizationById, listSalesReps } from "@aula-agente/database";
import { isLeadVisible, isManager, isSellerFilterEnabled, resolveLeadVisibility } from "./lead-visibility.js";

/** Para rotas de detalhe: false quando o lead pertence a outro vendedor. Gestores e flag desligada não consultam nada. */
export async function canViewLead(
  db: ReturnType<typeof getAdminClient>, organizationId: string, role: string, userId: string, ownerUserId: string | null | undefined
): Promise<boolean> {
  if (isManager(role) || !ownerUserId || ownerUserId === userId) return true;
  const org = await getOrganizationById(db, organizationId);
  const viewer = resolveLeadVisibility({ role, userId, leadDistributionEnabled: isSellerFilterEnabled(org.settings) });
  if (viewer.mode === "all") return true;
  const reps = await listSalesReps(db, organizationId);
  return isLeadVisible(viewer, ownerUserId, new Set(reps.map(r => r.user_id)));
}

/**
 * Pode atribuir o lead a `newOwner`? Gestores sempre. Não gestor: só a si mesmo ou a ninguém (soltar), ou a quem não é vendedor.
 * Passar o lead a OUTRO vendedor é privilégio do gestor (mesma regra do WITH CHECK das políticas RLS).
 */
export async function canAssignLead(
  db: ReturnType<typeof getAdminClient>, organizationId: string, role: string, userId: string, newOwner: string | null | undefined
): Promise<boolean> {
  if (isManager(role) || !newOwner || newOwner === userId) return true;
  const org = await getOrganizationById(db, organizationId);
  if (!isSellerFilterEnabled(org.settings)) return true;
  const reps = await listSalesReps(db, organizationId);
  return !reps.some(r => r.user_id === newOwner);
}
